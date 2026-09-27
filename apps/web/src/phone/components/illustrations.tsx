// Small engraved illustrations for full-screen states (sealed letter, rolled chart, broken seal).

export function SealedLetterArt() {
  return (
    <svg className="illus" width="200" height="130" viewBox="0 0 200 130" fill="none" stroke="var(--ink)" strokeWidth="1.5" aria-hidden>
      <path d="M20 22h160v92H20z" fill="var(--paper)" />
      <path d="M20 22l80 58 80-58" />
      <path d="M20 114l62-44M180 114l-62-44" stroke="var(--ink-soft)" />
      <g transform="translate(100 80)">
        <path d="M0-22l6 4 7-1 3 6 6 3-1 7 4 6-4 6 1 7-6 3-3 6-7-1-6 4-6-4-7 1-3-6-6-3 1-7-4-6 4-6-1-7 6-3 3-6 7 1z" fill="var(--sounding-red)" stroke="none" />
        <circle r="12" stroke="var(--paper)" strokeOpacity=".55" />
        <text y="6" textAnchor="middle" fontFamily="var(--f-display)" fontSize="17" fill="var(--paper)" stroke="none">T</text>
      </g>
    </svg>
  );
}

export function RolledChartArt() {
  return (
    <svg className="illus" width="220" height="120" viewBox="0 0 220 120" fill="none" stroke="var(--ink)" strokeWidth="1.5" aria-hidden>
      <rect x="30" y="40" width="160" height="40" rx="20" fill="var(--paper)" />
      <ellipse cx="190" cy="60" rx="9" ry="20" fill="var(--paper-deep)" />
      <path d="M190 48c-3 0-4 5-4 12s1 12 4 12" stroke="var(--ink-soft)" />
      <path d="M55 42v36M160 42v36" stroke="var(--ink-soft)" strokeDasharray="2 3" />
      <path d="M105 38c-6 10-6 34 0 44M113 38c6 10 6 34 0 44" stroke="var(--brass-dark)" strokeWidth="2" />
      <path d="M109 82c-8 10-14 16-22 20M109 82c6 9 12 15 20 18" stroke="var(--brass-dark)" strokeWidth="2" />
      <circle cx="109" cy="60" r="11" fill="var(--sounding-red)" stroke="none" />
      <text x="109" y="65" textAnchor="middle" fontFamily="var(--f-display)" fontSize="14" fill="var(--paper)" stroke="none">T</text>
    </svg>
  );
}

export function BrokenSealArt() {
  return (
    <svg className="illus" width="160" height="110" viewBox="0 0 160 110" fill="none" aria-hidden>
      <g transform="translate(70 55) rotate(-8)">
        <path d="M0-34l-8 5-10-1-4 9-9 4 1 10-6 8 6 8-1 10 9 4 4 9 10-1 8 5 3-10-6-12 5-16-5-14z" fill="var(--sounding-red)" />
      </g>
      <g transform="translate(92 57) rotate(10)">
        <path d="M-3-34l8 5 10-1 4 9 9 4-1 10 6 8-6 8 1 10-9 4-4 9-10-1-8 5 2-12 6-10-4-16 6-12z" fill="var(--sounding-red)" />
      </g>
      <path d="M80 18l-4 22 7 14-5 16 3 22" stroke="var(--paper)" strokeWidth="2" />
    </svg>
  );
}
