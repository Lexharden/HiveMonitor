//! Puente HiveMonitor ⇄ TikTok LIVE.
//!
//! Usa `piratetok-live-rs` (sin servicio de firma ni API key) y emite cada evento como una línea JSON por stdout.
//! HiveMonitor lanza un proceso por canal, lee las líneas y lo detiene cerrando stdin o con una señal.
//!
//! Uso: `tiktok-bridge <usuario> [--max-retries N] [--proxy URL] [--cookies COOKIES]`
//!
//! Códigos de salida: 0 fin normal · 10 canal sin directo · 11 usuario inexistente · 12 bloqueo/límite de TikTok ·
//! 13 otro error · 20 conexión perdida tras agotar reintentos · 2 uso incorrecto.

use std::time::Duration;

use piratetok_live_rs::TikTokLive;
use piratetok_live_rs::errors::TikTokLiveError;
use piratetok_live_rs::helpers::gift_streak::GiftStreakTracker;
use piratetok_live_rs::structs::TikTokLiveEvent;
use piratetok_live_rs::structs::proto::user::UserIdentity;
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

const EXIT_OFFLINE: u8 = 10;
const EXIT_NOT_FOUND: u8 = 11;
const EXIT_BLOCKED: u8 = 12;
const EXIT_OTHER: u8 = 13;
const EXIT_LOST: u8 = 20;

/// Una línea JSON por evento; `println!` usa búfer de línea, así que el padre las recibe al instante.
fn emit(v: Value) {
    println!("{v}");
}

fn user(u: &Option<UserIdentity>) -> Value {
    match u {
        Some(u) => json!({
            "id": u.user_id.to_string(),
            "name": if u.nickname.is_empty() { u.unique_id.as_str() } else { u.nickname.as_str() },
            "handle": u.unique_id,
            "avatar": u.avatar_thumb.as_ref().and_then(|i| i.url_list.first()),
        }),
        None => Value::Null,
    }
}

fn classify(err: &TikTokLiveError) -> (&'static str, u8) {
    match err {
        TikTokLiveError::HostNotOnline(_) => ("offline", EXIT_OFFLINE),
        TikTokLiveError::UserNotFound(_) => ("not_found", EXIT_NOT_FOUND),
        TikTokLiveError::DeviceBlocked => ("blocked", EXIT_BLOCKED),
        other => {
            let s = other.to_string().to_lowercase();
            if s.contains("429") || s.contains("403") || s.contains("blocked") {
                ("blocked", EXIT_BLOCKED)
            } else {
                ("other", EXIT_OTHER)
            }
        }
    }
}

struct Args {
    username: String,
    max_retries: u32,
    proxy: Option<String>,
    cookies: Option<String>,
}

fn parse_args() -> Option<Args> {
    let mut it = std::env::args().skip(1);
    let username = it.next().filter(|u| !u.starts_with("--"))?;
    let mut a = Args {
        username,
        max_retries: 3,
        proxy: None,
        cookies: None,
    };
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--max-retries" => a.max_retries = it.next()?.parse().ok()?,
            "--proxy" => a.proxy = Some(it.next()?),
            "--cookies" => a.cookies = Some(it.next()?),
            _ => return None,
        }
    }
    Some(a)
}

#[tokio::main]
async fn main() {
    // `process::exit` y no un simple retorno: la lectura bloqueante de stdin mantendría vivo el runtime al cerrar
    let code = run().await;
    std::process::exit(code.into());
}

async fn run() -> u8 {
    let Some(args) = parse_args() else {
        eprintln!(
            "uso: tiktok-bridge <usuario> [--max-retries N] [--proxy URL] [--cookies COOKIES]"
        );
        return 2;
    };

    // Si el proceso padre cierra stdin (o muere), terminamos: nunca quedan puentes huérfanos.
    let stdin_closed = tokio::spawn(async {
        let mut buf = [0u8; 64];
        let mut stdin = tokio::io::stdin();
        while matches!(stdin.read(&mut buf).await, Ok(n) if n > 0) {}
    });

    let mut builder = TikTokLive::builder(&args.username)
        .max_retries(args.max_retries)
        .timeout(Duration::from_secs(10));
    if let Some(p) = &args.proxy {
        builder = builder.proxy(p);
    }
    if let Some(c) = &args.cookies {
        builder = builder.cookies(c);
    }

    let mut stream = match builder.connect().await {
        Ok(s) => s,
        Err(e) => {
            let (kind, code) = classify(&e);
            emit(json!({ "t": "error", "kind": kind, "message": e.to_string() }));
            return code;
        }
    };

    let mut tracker = GiftStreakTracker::new();
    let mut ended = false;

    loop {
        let event = tokio::select! {
            ev = stream.next_event() => ev,
            _ = wait_stdin(&stdin_closed) => return 0,
        };
        let event = match event {
            Ok(e) => e,
            Err(TikTokLiveError::ConnectionClosed) => break,
            Err(e) => {
                let (kind, code) = classify(&e);
                emit(json!({ "t": "error", "kind": kind, "message": e.to_string() }));
                return code;
            }
        };

        match event {
            TikTokLiveEvent::Connected { room_id } => {
                emit(json!({ "t": "connected", "roomId": room_id }))
            }
            TikTokLiveEvent::Reconnecting {
                attempt,
                delay_secs,
                ..
            } => emit(json!({ "t": "reconnecting", "attempt": attempt, "delaySec": delay_secs })),
            TikTokLiveEvent::Chat(m) => emit(json!({
                "t": "chat",
                "id": m.common.as_ref().map(|c| c.msg_id.to_string()),
                "user": user(&m.user),
                "text": m.comment,
            })),
            TikTokLiveEvent::Gift(m) => {
                // Los regalos en racha emiten un evento por incremento: solo se reporta el total al cerrar la racha.
                let e = tracker.process(&m);
                if e.is_final {
                    emit(json!({
                        "t": "gift",
                        "id": m.common.as_ref().map(|c| c.msg_id.to_string()),
                        "user": user(&m.user),
                        "name": m.gift_details.as_ref().map(|g| g.gift_name.as_str()),
                        "count": e.total_gift_count.max(1),
                        "diamonds": e.total_diamond_count,
                    }));
                }
            }
            TikTokLiveEvent::Like(m) => emit(json!({
                "t": "like",
                "id": m.common.as_ref().map(|c| c.msg_id.to_string()),
                "user": user(&m.user),
                "count": m.like_count,
            })),
            TikTokLiveEvent::Follow(m) => emit(json!({
                "t": "follow",
                "id": m.common.as_ref().map(|c| c.msg_id.to_string()),
                "user": user(&m.user),
            })),
            TikTokLiveEvent::Share(m) => emit(json!({
                "t": "share",
                "id": m.common.as_ref().map(|c| c.msg_id.to_string()),
                "user": user(&m.user),
            })),
            TikTokLiveEvent::RoomUserSeq(m) => {
                emit(json!({ "t": "viewers", "count": m.viewer_count }))
            }
            TikTokLiveEvent::LiveEnded(_) => {
                ended = true;
                emit(json!({ "t": "ended" }));
            }
            TikTokLiveEvent::Disconnected => {
                emit(json!({ "t": "disconnected" }));
                return if ended { 0 } else { EXIT_LOST };
            }
            _ => {}
        }
    }
    if ended { 0 } else { EXIT_LOST }
}

/// Resuelve cuando stdin se cierra.
async fn wait_stdin(handle: &tokio::task::JoinHandle<()>) {
    while !handle.is_finished() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
