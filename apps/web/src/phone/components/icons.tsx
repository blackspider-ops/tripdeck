// Engraved line icons (docs/02-design-language.md §6): 1.5px stroke at 24px, square caps, chart-symbol style.
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number; title?: string };

function Base({ size = 24, title, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}
      strokeLinecap="square" strokeLinejoin="miter" role={title ? "img" : "presentation"} aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Anchor = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="4.5" r="1.8" />
    <path d="M12 6.3v14.2M8 9.5h8M4 13.5c0 4 3.6 7 8 7s8-3 8-7M4 13.5l-1.5 1.5M4 13.5l1.8 1.2M20 13.5l1.5 1.5M20 13.5l-1.8 1.2" />
  </Base>
);

export const SealedLetter = (p: P) => (
  <Base {...p}>
    <path d="M3 6.5h18v12H3z" />
    <path d="M3 6.5l9 7 9-7" />
    <circle cx="12" cy="14" r="2.6" fill="currentColor" stroke="none" />
  </Base>
);

export const CompassRose = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 2.5l1.6 8L12 12l-1.6-1.5zM12 21.5l-1.6-8L12 12l1.6 1.5zM2.5 12l8-1.6L12 12l-1.5 1.6zM21.5 12l-8 1.6L12 12l1.5-1.6z" />
  </Base>
);

export const Dividers = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="4" r="1.6" />
    <path d="M11.2 5.4L5 21M12.8 5.4L19 21M8 13.5h8" />
  </Base>
);

export const SpeakingTrumpet = (p: P) => (
  <Base {...p}>
    <path d="M4 10.5h3v3H4zM7 10.5l12-5v13l-12-5" />
    <path d="M21 9.5v5" />
  </Base>
);

export const Bell = (p: P) => (
  <Base {...p}>
    <path d="M12 3v2M6.5 17c0-6 1.5-10 5.5-10s5.5 4 5.5 10zM4.5 17h15" />
    <circle cx="12" cy="19.5" r="1.3" />
  </Base>
);

export const Cloche = (p: P) => (
  <Base {...p}>
    <path d="M4 17c0-5 3.6-9 8-9s8 4 8 9" />
    <path d="M12 8V6M10.5 5.5h3M2.5 17h19M3.5 19.5h17" />
  </Base>
);

export const WaxSeal = (p: P) => (
  <Base {...p}>
    <path d="M12 3.2l2 1.4 2.4-.3 1 2.2 2.2 1-.3 2.4 1.4 2-1.4 2 .3 2.4-2.2 1-1 2.2-2.4-.3-2 1.4-2-1.4-2.4.3-1-2.2-2.2-1 .3-2.4-1.4-2 1.4-2-.3-2.4 2.2-1 1-2.2 2.4.3z" />
    <circle cx="12" cy="12" r="4.4" />
    <path d="M10 13.8l2-4.4 2 4.4M10.8 12.4h2.4" />
  </Base>
);

export const BrokenSeal = (p: P) => (
  <Base {...p}>
    <path d="M11 3.4l-1 1.2-2.4-.3-1 2.2-2.2 1 .3 2.4-1.4 2 1.4 2-.3 2.4 2.2 1 1 2.2 2.4-.3 1 1.2" />
    <path d="M13 20.6l1-1.2 2.4.3 1-2.2 2.2-1-.3-2.4 1.4-2-1.4-2 .3-2.4-2.2-1-1-2.2-2.4.3-1-1.2" />
    <path d="M12 3l-1.5 5 2.5 3-2 4 1.5 6" />
  </Base>
);

export const Lighthouse = (p: P) => (
  <Base {...p}>
    <path d="M9 21l1.5-12h3L15 21zM10 9h4M9.5 6.5h5L14 9h-4zM12 4.5v2" />
    <path d="M4 7l4 1M20 7l-4 1M6 21h12" />
  </Base>
);

export const Ledger = (p: P) => (
  <Base {...p}>
    <path d="M5 3.5h13v17H5z" />
    <path d="M8 3.5v17M10.5 8h5M10.5 11h5M10.5 14h5M10.5 17h3" />
  </Base>
);

export const Hourglass = (p: P) => (
  <Base {...p}>
    <path d="M6 3h12M6 21h12M7.5 3c0 5 4.5 6 4.5 9s-4.5 4-4.5 9M16.5 3c0 5-4.5 6-4.5 9s4.5 4 4.5 9" />
    <path d="M10 18.5h4" />
  </Base>
);

export const Spyglass = (p: P) => (
  <Base {...p}>
    <path d="M3 15.5l12-8 2.5 3.8-12 8z" />
    <path d="M15 7.5l3-2 2.5 3.8-3 2M7 13l2.5 3.8" />
  </Base>
);

/** A pencil: marks a value pencilled in from memory (doc 03 P4), until the member changes it. */
export const Pencil = (p: P) => (
  <Base {...p}>
    <path d="M4 20l1.2-4.8L16.5 3.9l3.6 3.6L8.8 18.8z" />
    <path d="M14.3 6.1l3.6 3.6M5.2 15.2l3.6 3.6" />
  </Base>
);
