// ============================================================
// layout.js — Root layout for the entire application
//
// This is the top-level layout in Next.js App Router. Every
// page in the app is rendered inside this layout. It provides:
//   1. HTML structure (html, head, body tags)
//   2. Global fonts (Geist Sans + Geist Mono from Google Fonts)
//   3. Global CSS (imported from globals.css)
//   4. AuthProvider — makes auth state available everywhere
//   5. Navbar — shown on every page
//
// WHY AuthProvider is here (not in individual pages):
//   Auth state needs to be shared across ALL pages — the Navbar
//   needs it, every protected page needs it, and it must persist
//   across page navigations. Putting it at the root layout
//   ensures a single instance wraps the entire app.
// ============================================================

import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/app/context/AuthContext";
import Navbar from "@/app/components/Navbar";

// Load Google Fonts with Next.js font optimization.
// This downloads the fonts at build time and serves them
// from your own domain — no external requests, no layout shift.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// SEO metadata — Next.js injects this into the <head>.
export const metadata = {
  title: "EventTix — Live Event Ticketing",
  description:
    "Real-time seat-based ticket booking platform with live seat maps, waiting rooms, and secure payments.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* AuthProvider wraps everything so any component can
            call useAuth() to access user, login(), logout(). */}
        <AuthProvider>
          {/* Navbar is outside {children} so it appears on
              every page without each page rendering it individually. */}
          <Navbar />

          {/* The current page's content renders here.
              flex-1 makes it take all remaining vertical space
              so the footer (when added) sticks to the bottom. */}
          <main className="flex-1">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
