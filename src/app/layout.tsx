import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'StoryBoard',
  description: 'Collaborative whiteboard for building stories',
}

// System font stack, no webfont. A tool UI has no business blocking first paint on a font
// download, and the canvas renders text with the same stack so overlays match exactly.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 antialiased">{children}</body>
    </html>
  )
}
