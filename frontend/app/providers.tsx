"use client";

// Thin client wrapper so layout.tsx can stay a server component
// while still providing the AuthContext to the entire tree.

import { AuthProvider } from "@/lib/auth-context";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
