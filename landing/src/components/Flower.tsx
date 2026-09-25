export function Flower({ light = false }: { light?: boolean }) {
  return (
    <svg aria-hidden="true" className={light ? "flower flower-light" : "flower"} viewBox="0 0 28 28">
      <circle cx="14" cy="6.5" r="4.2" />
      <circle cx="21.1" cy="11.7" r="4.2" />
      <circle cx="18.4" cy="20" r="4.2" />
      <circle cx="9.6" cy="20" r="4.2" />
      <circle cx="6.9" cy="11.7" r="4.2" />
      <circle className="flower-center" cx="14" cy="14" r="3.2" />
    </svg>
  );
}
