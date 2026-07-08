import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./ModalDialog.css";

export interface ModalDialogProps {
  bodyClassName?: string;
  cancelDisabled?: boolean;
  cancelLabel?: string;
  children: ReactNode;
  className?: string;
  closeTitle?: string;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function playPromptSound() {
  try {
    const AudioContextClass =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    const context = new AudioContextClass();
    const now = context.currentTime;
    const notes = [740, 740, 740];

    notes.forEach((frequency, index) => {
      const start = now + index * 0.13;
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.085);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.095);
    });

    window.setTimeout(() => void context.close(), 520);
  } catch {
    // Audio feedback is best-effort; the visual alert still runs if audio is blocked.
  }
}

export function ModalDialog({
  bodyClassName,
  cancelDisabled = false,
  cancelLabel = "取消",
  children,
  className,
  closeTitle = "关闭",
  confirmDisabled = false,
  confirmLabel = "确定",
  title,
  onCancel,
  onConfirm,
}: ModalDialogProps) {
  const titleId = useId();
  const [attentionActive, setAttentionActive] = useState(false);
  const attentionTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (attentionTimerRef.current !== null) {
        window.clearTimeout(attentionTimerRef.current);
      }
    },
    [],
  );

  function requestAttention() {
    playPromptSound();
    if (attentionTimerRef.current !== null) {
      window.clearTimeout(attentionTimerRef.current);
    }
    setAttentionActive(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setAttentionActive(true);
        attentionTimerRef.current = window.setTimeout(() => {
          setAttentionActive(false);
          attentionTimerRef.current = null;
        }, 640);
      });
    });
  }

  return (
    <div className="modal-dialog-backdrop" role="presentation" onMouseDown={requestAttention}>
      <section
        className={`modal-dialog ${attentionActive ? "attention" : ""} ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="modal-dialog-close"
            onClick={onCancel}
            title={closeTitle}
          >
            <X size={24} />
          </button>
        </header>

        <div className={`modal-dialog-body ${bodyClassName ?? ""}`}>{children}</div>

        <footer className="modal-dialog-actions">
          <button
            type="button"
            className="modal-dialog-confirm"
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            className="modal-dialog-cancel"
            onClick={onCancel}
            disabled={cancelDisabled}
          >
            {cancelLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
