// "The Gap" — flat variant from the logo sheet, with an optionally-breathing lamp.
export default function Logo({
  size = 28,
  breathe = false,
}: {
  size?: number;
  breathe?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="AfterMarketMovers"
    >
      <rect width="64" height="64" rx="14" fill="#0E0508" />
      <rect
        x=".75"
        y=".75"
        width="62.5"
        height="62.5"
        rx="13.4"
        fill="none"
        stroke="#3A1224"
        strokeWidth="1.5"
      />
      <line
        x1="32"
        y1="13"
        x2="32"
        y2="51"
        stroke="#4A1B33"
        strokeWidth="3"
        strokeDasharray="1.5 6"
        strokeLinecap="round"
      />
      <g stroke="#FF2E88" strokeLinecap="round" fill="none">
        <line x1="10" y1="42" x2="27" y2="42" strokeWidth="6" />
        <line x1="37" y1="22" x2="50" y2="22" strokeWidth="6" />
      </g>
      <circle
        className={breathe ? "lamp" : undefined}
        cx="54"
        cy="22"
        r="5"
        fill="#FF2E88"
      />
      <circle cx="54" cy="22" r="2" fill="#FFE6F1" />
    </svg>
  );
}
