import { Flower } from "./Flower";

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <div className={light ? "wordmark wordmark-light" : "wordmark"} aria-label="Mimoza">
      mimoza
      <Flower light={light} />
    </div>
  );
}
