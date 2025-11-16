import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b-4 border-black bg-white">
        <nav className="container-custom py-4">
          <div className="flex-between">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-bold text-black">VOW</h1>
              <span className="text-sm bg-yellow-400 px-2 py-1 font-bold uppercase tracking-wide">
                Beta
              </span>
            </div>
            
            <div className="flex items-center gap-4">
              <Link 
                href="/auth/signin"
                className="px-4 py-2 border-4 border-black bg-white hover:bg-gray-100 transition-colors font-mono font-bold"
              >
                Sign In
              </Link>
              <Link 
                href="/auth/signup"
                className="px-4 py-2 border-4 border-black bg-black text-white hover:bg-gray-800 transition-colors font-mono font-bold"
              >
                Get Started
              </Link>
            </div>
          </div>
        </nav>
      </header>

      {/* Hero Section */}
      <section className="container-custom py-16 lg:py-24">
        <div className="text-center max-w-4xl mx-auto">
          <h1 className="text-6xl md:text-8xl font-bold mb-8 text-black">
            Your Reading
            <br />
            <span className="text-yellow-400 bg-black px-4 py-2 inline-block border-4 border-black">
              Portfolio
            </span>
          </h1>
          
          <p className="text-xl md:text-2xl mb-12 text-gray-700 leading-relaxed">
            Track books, papers, and articles. Share your intellectual journey. 
            Build your digital brain profile.
          </p>

          <div className="flex flex-col sm:flex-row gap-6 justify-center">
            <Link 
              href="/auth/signup"
              className="px-8 py-4 border-4 border-black bg-black text-white text-lg font-bold hover:bg-gray-800 transition-colors transform hover:scale-105"
            >
              Start Building Your Profile
            </Link>
            <Link 
              href="/demo"
              className="px-8 py-4 border-4 border-black bg-white text-black text-lg font-bold hover:bg-gray-100 transition-colors"
            >
              View Demo
            </Link>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="border-y-4 border-black bg-gray-100">
        <div className="container-custom py-16">
          <h2 className="text-4xl font-bold text-center mb-16">Why Vow?</h2>
          
          <div className="grid md:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">📚</div>
              <h3 className="text-xl font-bold mb-4">Track Everything</h3>
              <p className="text-gray-700">
                Books, academic papers, articles - one place for your entire reading journey. 
                Never lose track of what you've read again.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">🌟</div>
              <h3 className="text-xl font-bold mb-4">Social Showcase</h3>
              <p className="text-gray-700">
                Share your reading profile with the world. Build your intellectual reputation 
                and discover what others are reading.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">⚡</div>
              <h3 className="text-xl font-bold mb-4">Lightning Fast</h3>
              <p className="text-gray-700">
                Add books with ISBN scan, auto-fetch metadata, and search across your 
                collection instantly. Built for speed.
              </p>
            </div>

            {/* Feature 4 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">🎯</div>
              <h3 className="text-xl font-bold mb-4">Smart Discovery</h3>
              <p className="text-gray-700">
                Find new reads based on your interests and what people in your network 
                are reading. Never run out of recommendations.
              </p>
            </div>

            {/* Feature 5 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">📈</div>
              <h3 className="text-xl font-bold mb-4">Reading Analytics</h3>
              <p className="text-gray-700">
                Track your reading streaks, genres, and progress. Gamify your learning 
                journey with beautiful stats.
              </p>
            </div>

            {/* Feature 6 */}
            <div className="border-4 border-black bg-white p-8 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] transition-shadow">
              <div className="text-4xl mb-4">🔒</div>
              <h3 className="text-xl font-bold mb-4">Privacy First</h3>
              <p className="text-gray-700">
                Control who sees your reading list. Public, unlisted, or completely 
                private - you decide what to share.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Demo Section */}
      <section className="container-custom py-16">
        <div className="text-center mb-12">
          <h2 className="text-4xl font-bold mb-4">See It In Action</h2>
          <p className="text-xl text-gray-700">
            A glimpse of what your reading profile could look like
          </p>
        </div>

        {/* Mock Profile Preview */}
        <div className="max-w-4xl mx-auto border-4 border-black bg-white p-8 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)]">
          <div className="flex items-start gap-6 mb-8">
            <div className="w-24 h-24 border-4 border-black bg-gray-200 flex-center">
              <span className="text-2xl">👤</span>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold">@alex_reader</h3>
              <p className="text-gray-600 mb-4">Passionate learner • Tech & Philosophy</p>
              <div className="flex gap-4 text-sm">
                <span className="bg-gray-100 px-2 py-1 border-2 border-black">
                  📚 156 books
                </span>
                <span className="bg-gray-100 px-2 py-1 border-2 border-black">
                  🔬 43 papers
                </span>
                <span className="bg-gray-100 px-2 py-1 border-2 border-black">
                  🔥 23 day streak
                </span>
              </div>
            </div>
            <button className="px-4 py-2 border-4 border-black bg-yellow-400 font-bold hover:bg-yellow-500">
              Follow
            </button>
          </div>

          {/* Mock Items Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { title: "Clean Code", author: "Robert Martin", type: "BOOK", status: "READ" },
              { title: "The Algorithm Design Manual", author: "Steven Skiena", type: "BOOK", status: "READING" },
              { title: "Attention Is All You Need", author: "Vaswani et al.", type: "PAPER", status: "WANT_TO_READ" },
              { title: "Thinking, Fast and Slow", author: "Daniel Kahneman", type: "BOOK", status: "READ" },
            ].map((item, index) => (
              <div key={index} className="border-2 border-black bg-gray-50 p-3 hover:bg-gray-100 transition-colors">
                <div className="aspect-[3/4] bg-gray-200 border border-black mb-2 flex-center text-xs text-gray-500">
                  Cover
                </div>
                <h4 className="text-sm font-bold line-clamp-2 mb-1">{item.title}</h4>
                <p className="text-xs text-gray-600 mb-2">{item.author}</p>
                <div className="flex justify-between items-center">
                  <span className="text-xs px-2 py-1 bg-blue-100 border border-black">
                    {item.type.toLowerCase()}
                  </span>
                  <span className={`text-xs px-1 py-0.5 border border-black ${
                    item.status === 'READ' ? 'bg-green-100' :
                    item.status === 'READING' ? 'bg-yellow-100' : 'bg-gray-100'
                  }`}>
                    {item.status.replace('_', ' ').toLowerCase()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="bg-black text-white py-16">
        <div className="container-custom text-center">
          <h2 className="text-4xl font-bold mb-8">Ready to Start?</h2>
          <p className="text-xl mb-12 text-gray-300">
            Join thousands of readers building their digital brain profiles
          </p>
          <div className="flex flex-col sm:flex-row gap-6 justify-center">
            <Link 
              href="/auth/signup"
              className="px-8 py-4 border-4 border-white bg-white text-black text-lg font-bold hover:bg-gray-100 transition-colors"
            >
              Create Your Free Account
            </Link>
            <Link 
              href="/demo"
              className="px-8 py-4 border-4 border-white bg-transparent text-white text-lg font-bold hover:bg-white hover:text-black transition-colors"
            >
              Explore Demo
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t-4 border-black bg-white py-8">
        <div className="container-custom">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-4">
              <h3 className="text-xl font-bold">VOW</h3>
              <span className="text-sm text-gray-600">© 2025 MiniMax Agent</span>
            </div>
            
            <div className="flex gap-6 text-sm">
              <Link href="/privacy" className="hover:text-gray-600">
                Privacy
              </Link>
              <Link href="/terms" className="hover:text-gray-600">
                Terms
              </Link>
              <Link href="/contact" className="hover:text-gray-600">
                Contact
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
