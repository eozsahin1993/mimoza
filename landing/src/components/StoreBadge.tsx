import type { KeyboardEvent } from "react";
import { Icon } from "./Icon";

const STORE_URLS = {
  Apple: "https://www.apple.com/app-store/",
  Google: "https://play.google.com/store",
} as const;

export function StoreBadge({ store }: { store: "Apple" | "Google" }) {
  const goToStore = () => {
    window.location.href = STORE_URLS[store];
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") goToStore();
  };

  return (
    <div className="store-badge" role="link" tabIndex={0} onClick={goToStore} onKeyDown={onKeyDown}>
      <Icon name={store === "Apple" ? "apple" : "play"} size={27} />
      <div>
        <span>{store === "Apple" ? "Download on the" : "GET IT ON"}</span>
        <strong>{store === "Apple" ? "App Store" : "Google Play"}</strong>
      </div>
    </div>
  );
}
