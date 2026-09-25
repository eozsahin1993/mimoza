import type { ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  apple: (
    <>
      <path d="M16.8 13.7c0-2.8 2.3-4.2 2.4-4.3a5.2 5.2 0 0 0-4.1-2.2c-1.8-.2-3.4 1-4.3 1-.9 0-2.2-1-3.7-1a5.4 5.4 0 0 0-4.6 2.8c-2 3.4-.5 8.5 1.4 11.3.9 1.4 2.1 2.9 3.6 2.8 1.4-.1 2-1 3.7-1s2.2 1 3.7 1c1.5 0 2.5-1.4 3.4-2.8a12.2 12.2 0 0 0 1.6-3.3 4.8 4.8 0 0 1-3.1-4.3Z" />
      <path d="M14 5.3A4.8 4.8 0 0 0 15.1 2a4.9 4.9 0 0 0-3.2 1.6 4.5 4.5 0 0 0-1.2 3.2A4 4 0 0 0 14 5.3Z" />
    </>
  ),
  play: <path d="m4 3 15 9-15 9V3Zm0 0 10 10m5-1L8 22" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
      <path d="M10 21h4" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="m5 12 14 0m-5-5 5 5-5 5" />,
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" />
    </>
  ),
  cloud: (
    <>
      <path d="M7 18h11a4 4 0 0 0 .5-8A7 7 0 0 0 5 11.5 3.5 3.5 0 0 0 7 18Z" />
      <path d="m9.5 14 2.5-2.5 2.5 2.5M12 11.5V17" />
    </>
  ),
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill={name === "apple" ? "currentColor" : "none"}
      height={size}
      stroke={name === "apple" ? "none" : "currentColor"}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}
