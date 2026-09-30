import mumPhoto from "../assets/privacy-mum.jpg";
import alexPhoto from "../assets/privacy-alex.jpg";
import janePhoto from "../assets/privacy-jane.jpg";

// One coordinate system for the whole diagram (a 520×460 SVG viewBox), so
// the connecting lines and the faces they connect are computed from the
// same numbers and can never drift out of alignment with each other.
const LOCK = { x: 260, y: 220, r: 85 };
const NODES = [
  { name: "Alex", x: 90, y: 90, photo: alexPhoto },
  { name: "Mum", x: 430, y: 75, photo: mumPhoto },
  { name: "Jane", x: 430, y: 355, photo: janePhoto },
];
const NODE_R = 33;

export function PrivacySection() {
  return (
    <section className="privacy-section" id="privacy">
      <div className="privacy-copy">
        <span className="kicker kicker-dark">Private where it matters</span>
        <div className="display privacy-title" role="heading" aria-level={2}>
          We can deliver it.
          <br />
          We can't read it.
        </div>
        <p>
          Photos, captions, comments, and reactions are encrypted on your phone before they're ever sent. We pass
          along locked packages—never the key that opens them.
        </p>
        <div className="honesty-note">
          <span className="honesty-mark">i</span>
          <div>
            <strong>Privacy, plainly stated.</strong>
            <p>We can see who's in a circle and when something happens there. We can't see what was shared.</p>
          </div>
        </div>
      </div>
      <div className="encryption-visual">
        <svg viewBox="0 0 520 460" role="img" aria-label="Alex, Mum and Jane's circle, connected by an encrypted link">
          <defs>
            {NODES.map((n) => (
              <clipPath id={`clip-${n.name}`} key={n.name}>
                <circle cx={n.x} cy={n.y} r={NODE_R} />
              </clipPath>
            ))}
          </defs>

          {NODES.map((n) => (
            <line key={n.name} className="connection-line" x1={n.x} y1={n.y} x2={LOCK.x} y2={LOCK.y} />
          ))}

          <circle className="lock-ring" cx={LOCK.x} cy={LOCK.y} r={LOCK.r + 21} />
          <circle className="lock-ring" cx={LOCK.x} cy={LOCK.y} r={LOCK.r + 9} />
          <circle className="lock-circle" cx={LOCK.x} cy={LOCK.y} r={LOCK.r} />
          <g className="lock-icon" transform={`translate(${LOCK.x - 17} ${LOCK.y - 46}) scale(1.4)`}>
            <rect x="5" y="10" width="14" height="11" rx="3" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
          </g>
          <text className="lock-title" x={LOCK.x} y={LOCK.y + 18} textAnchor="middle">
            Your circle
          </text>
          <text className="lock-sub" x={LOCK.x} y={LOCK.y + 36} textAnchor="middle">
            Only they can see it
          </text>

          {NODES.map((n) => (
            <g key={n.name}>
              <image href={n.photo} x={n.x - NODE_R} y={n.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2} clipPath={`url(#clip-${n.name})`} preserveAspectRatio="xMidYMid slice" />
              <circle className="node-ring" cx={n.x} cy={n.y} r={NODE_R} />
              <text className="node-label" x={n.x} y={n.y + NODE_R + 20} textAnchor="middle">
                {n.name}
              </text>
            </g>
          ))}

          <g className="encrypted-chip">
            <rect x={LOCK.x - 92} y="432" width="184" height="26" rx="13" />
            <text x={LOCK.x} y="449" textAnchor="middle">
              ENCRYPTED CONTENT
            </text>
          </g>
        </svg>
      </div>
    </section>
  );
}
