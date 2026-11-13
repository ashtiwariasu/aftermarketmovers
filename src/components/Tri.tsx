/**
 * The orange triangle — AMM's mark, echoing the stud on the fox's ear.
 * Replaces the old asterisk in the wordmark. Slightly tilted, like the stud.
 */
export default function Tri({ size = "0.5em" }: { size?: string }) {
  return (
    <svg
      viewBox="0 0 12 11"
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: `calc(${size} * 0.92)`,
        marginLeft: "0.09em",
        transform: "rotate(12deg)",
      }}
    >
      <polygon points="6,0 12,11 0,11" fill="var(--pr-orange, #FF4D1F)" />
    </svg>
  );
}
