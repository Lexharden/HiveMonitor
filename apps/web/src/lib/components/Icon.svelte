<script module lang="ts">
  const paths = {
    live: "M3 12h4l3-8 4 16 3-8h4",
    chat: "M4 5h16v11H9l-5 4V5z",
    events: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5 6.6 19.5l1.2-6L3.3 9.3l6.1-.7L12 3z",
    history: "M12 7v5l3 2M3 12a9 9 0 109-9 9 9 0 00-7 3.5M3 4v4h4",
    plug: "M9 3v5m6-5v5M6 8h12v4a6 6 0 01-12 0V8zm6 10v3",
    members: "M16 11a3 3 0 100-6 3 3 0 000 6zM8 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5m8 0c3 0 6 2 6 5M8 15c2 0 3 .3 4 1",
    bell: "M6 17V11a6 6 0 0112 0v6l2 2H4l2-2zm4 4h4",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
    settings:
      "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .5-1.5-1L15 4h-4l-.5 2.5-1.5 1L7 7 5 11l2 1v1l-2 1 2 4 2-.5 1.5 1L11 20h4l.5-2.5 1.5-1 2 .5 2-4-2-1v-1z",
    sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5",
    moon: "M20 14A8 8 0 0110 4a8 8 0 1010 10z",
    out: "M9 4H5v16h4m4-4l4-4-4-4m4 4H9",
    plus: "M12 5v14M5 12h14",
    flag: "M5 21V4m0 0h11l-2 4 2 4H5",
    bellOff: "M6 17V11a6 6 0 013-5.2M18 11v6l2 2H8M10 21h4M3 3l18 18",
    full: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    sun2: "M12 3v2m0 14v2M3 12h2m14 0h2M12 8a4 4 0 100 8 4 4 0 000-8z",
    cockpit: "M3 12a9 9 0 0118 0M12 12l4-4M5 18h14",
    trash: "M5 7h14M10 7V4h4v3m-6 0l1 13h6l1-13",
  } as const;
  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name, class: cls = "size-5" }: { name: IconName; class?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  class={cls}
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
