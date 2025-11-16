import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Vow - Your Reading Showcase',
  description: 'Track your reading journey and share your intellectual portfolio with the world.',
  keywords: ['reading', 'books', 'academic', 'portfolio', 'social'],
  authors: [{ name: 'MiniMax Agent' }],
  openGraph: {
    title: 'Vow - Your Reading Showcase',
    description: 'Track your reading journey and share your intellectual portfolio with the world.',
    url: 'https://vow.app',
    siteName: 'Vow',
    images: [
      {
        url: '/og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'Vow - Your Reading Showcase',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Vow - Your Reading Showcase',
    description: 'Track your reading journey and share your intellectual portfolio with the world.',
    images: ['/og-image.jpg'],
  },
  viewport: 'width=device-width, initial-scale=1',
  themeColor: '#000000',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="antialiased font-mono">
        <div className="min-h-screen bg-white text-black">
          {children}
        </div>
      </body>
    </html>
  )
}
