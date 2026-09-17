import "./ImportZoomControl.css";

export function ImportZoomControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <span className="import-zoom-control" title="缩略图大小">
      <svg viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M1 9.3 195 0a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5L1 10.7Z" />
      </svg>
      <input
        type="range"
        min="120"
        max="300"
        step="10"
        value={value}
        aria-label="缩略图大小"
        aria-valuetext={`${value} 像素`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </span>
  );
}
