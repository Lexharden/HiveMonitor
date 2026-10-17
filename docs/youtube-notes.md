# YouTube Live — notas para la implementación futura

El adaptador `packages/adapters/src/youtube` es un stub (`NotImplementedError`). Notas de cuota:

- La YouTube Data API v3 asigna **10 000 unidades/día por proyecto** de Google Cloud (ampliable solicitando una auditoría).
- `liveChatMessages.list` cuesta **~5 unidades por llamada**. Con sondeo cada `pollingIntervalMillis` (≈ 5–10 s),
  **un solo directo** gastaría 17 000+ unidades/día: se agota la cuota con 1–2 streamers simultáneos.
- `liveBroadcasts.list` / `videos.list` (estado, viewers concurrentes) cuestan 1 unidad; conviene sondearlos poco (≥ 30 s).
- Alternativa que no consume cuota de lectura repetida: `liveChatMessages.streamList` (gRPC/streaming), que mantiene la
  conexión abierta y se factura una vez por conexión; es la vía recomendada para múltiples tenants.
- Súper Chats y membresías llegan como mensajes de tipo `superChatEvent` / `newSponsorEvent`; mapear a `donation` y `subscription`.
- Cada tenant debe autorizar su canal por OAuth (scope `youtube.readonly`); los tokens se cifran igual que los de Twitch.
- Hay que gestionar cuota a nivel global (presupuesto por tenant, estado `rate_limited` al agotarse), igual que el servicio de firma de TikTok.
