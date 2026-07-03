"use client";
import { useState, useEffect, useRef } from "react";

export type ToastType = "success" | "error" | "info" | "warning";

const EVENT = "wco:toast";

export function toast(message: string, type: ToastType = "success") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, type } }));
}

const BG: Record<ToastType, string> = {
  success: "#0f6e56",
  error:   "#dc2626",
  info:    "#0369a1",
  warning: "#d97706",
};

const ICON: Record<ToastType, string> = {
  success: "✓",
  error:   "✕",
  info:    "ℹ",
  warning: "⚠",
};

interface ToastItem { id: number; message: string; type: ToastType; }

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  useEffect(() => {
    function handler(e: Event) {
      const { message, type } = (e as CustomEvent).detail as { message: string; type: ToastType };
      const id = ++counter.current;
      setItems(prev => [...prev, { id, message, type }]);
      setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 3200);
    }
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  if (items.length === 0) return null;

  return (
    <>
      <style>{`
        @keyframes wco-toast-in {
          from { transform: translateX(16px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
      <div style={{
        position: "fixed", bottom: 24, right: 24,
        display: "flex", flexDirection: "column", gap: 8,
        zIndex: 999999, pointerEvents: "none",
      }}>
        {items.map(t => (
          <div key={t.id} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "11px 16px",
            borderRadius: 11,
            fontSize: 13, fontWeight: 600,
            color: "white",
            background: BG[t.type],
            boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
            animation: "wco-toast-in 0.18s ease",
            maxWidth: 320,
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.4,
            minWidth: 200,
          }}>
            <span style={{ fontSize: 14, opacity: 0.9, flexShrink: 0 }}>{ICON[t.type]}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}
