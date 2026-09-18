import type { SVGProps } from "react";

/** The folder silhouette shared by the bottom-bar badge and the file browser. */
export function ImportFolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 100 88" fill="none" aria-hidden="true" {...props}>
      <path
        d="M8 20V13a8 8 0 0 1 8-8h20a9 9 0 0 1 6.2 2.5L52 16.5h32a8 8 0 0 1 8 8V27H8V20Z"
        fill="#B4B4B4"
      />
      <path
        d="M8 24a6 6 0 0 1 6-6h72a6 6 0 0 1 6 6v45a10 10 0 0 1-10 10H18A10 10 0 0 1 8 69V24Z"
        fill="#585858"
        stroke="#B4B4B4"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ImportFolderChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 67 78" fill="none" aria-hidden="true" {...props}>
      <path
        d="M15 29V24a2 2 0 0 1 2-2h12l7 7"
        stroke="#D0D0D0"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M14.25 29H34l2.5-2.75h18.25a2 2 0 0 1 2 2V55.5h-42.5V29Z" fill="#D0D0D0" />
      <path d="M27 38l8 8 8-8" stroke="#1D1D1D" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}
