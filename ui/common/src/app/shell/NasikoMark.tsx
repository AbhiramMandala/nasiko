/**
 * The Nasiko "N" barcode mark, inline so it takes `currentColor` (public/mark-nasiko.svg, the favicon,
 * keeps the fixed yellow-600). Yellow is the logo only (§6.4): colour it with `text-logo`, which is
 * yellow-600 `#BB8F06` in light mode and yellow-200 `#F7E19C` in dark mode.
 */
export function NasikoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden className={className}>
      <rect width="3.28807" height="53.743" rx="1.64403" />
      <rect x="5.51914" width="3.28807" height="58.4455" rx="1.64403" />
      <rect x="11.0384" width="3.28807" height="63.8199" rx="1.64403" />
      <rect x="16.5577" width="3.28807" height="63.8199" rx="1.64403" />
      <rect x="22.0771" width="3.28807" height="22.8408" rx="1.64403" />
      <rect x="27.5963" width="3.28807" height="22.8408" rx="1.64403" />
      <rect x="33.1154" width="3.28807" height="27.5433" rx="1.64403" />
      <rect x="38.6348" width="3.28807" height="32.2458" rx="1.64403" />
      <rect x="44.154" width="3.28807" height="22.8408" rx="1.64403" />
      <rect x="49.5559" y="6.02707" width="3.34837" height="16.7418" rx="1.67418" />
      <rect x="55.1927" y="10.2568" width="3.28807" height="53.743" rx="1.64403" />
      <rect x="60.7119" y="14.8154" width="3.28807" height="49.0405" rx="1.64403" />
      <rect x="22.3119" y="53.5633" width="3.34679" height="10.2568" rx="1.67339" />
      <rect x="27.8901" y="53.5633" width="3.28807" height="10.0768" rx="1.64403" />
      <rect x="33.4677" y="43.3064" width="3.34679" height="20.5136" rx="1.67339" />
      <rect x="39.0458" y="47.865" width="3.34679" height="15.955" rx="1.67339" />
      <rect x="44.3891" y="53.5633" width="3.34679" height="10.2568" rx="1.67339" />
      <rect x="49.9669" y="53.5633" width="3.34679" height="10.2568" rx="1.67339" />
    </svg>
  )
}
