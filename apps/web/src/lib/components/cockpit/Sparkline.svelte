<script lang="ts">
  /** Mini gráfica de ritmo (sin ejes): línea de 2 px y área suave; el valor actual lo muestra el padre. */
  let { values, color = "var(--series-1)", height = 36 }: { values: number[]; color?: string; height?: number } = $props();

  const W = 120;
  const max = $derived(Math.max(1, ...values));
  const pts = $derived(values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, height - 3 - (v / max) * (height - 6)] as const));
  const line = $derived(pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(""));
  const area = $derived(`${line}L${W},${height}L0,${height}Z`);
</script>

<svg viewBox="0 0 {W} {height}" class="block w-full" style:height="{height}px" preserveAspectRatio="none" aria-hidden="true">
  <path d={area} fill={color} opacity="0.14" />
  <path
    d={line}
    fill="none"
    stroke={color}
    stroke-width="2"
    stroke-linejoin="round"
    stroke-linecap="round"
    vector-effect="non-scaling-stroke"
  />
</svg>
