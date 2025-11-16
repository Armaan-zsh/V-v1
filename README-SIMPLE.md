# 📚 Vow Reading Portfolio (No AI Version)

**A clean, fast, and completely free reading portfolio platform**

## ✨ What is Vow?

Vow is a reading portfolio platform where you can:
- Track books, academic papers, and articles you're reading
- Create beautiful reading profiles to share with others
- Build reading lists and organize your intellectual journey
- Follow other readers and discover what they're reading
- Get insights into your reading habits (no AI needed!)

## 🎯 Why This Version?

This is the **AI-free version** of Vow, designed for:
- **Complete Privacy**: No data sent to external AI services
- **Zero API Costs**: No dependency on expensive AI APIs
- **Lightning Fast**: Instant responses, no AI processing delays
- **Fully Open Source**: You own your data and code
- **Easy to Deploy**: Minimal dependencies, maximum reliability

## 🚀 Quick Start

### Option 1: Automated Setup (Recommended)
```bash
# Run the setup script
./setup-simple.sh

# Or manually:
cp package-simple.json package.json
cp schema-simple.prisma prisma/schema.prisma
cp .env.example-simple .env.example
npm install
```

### Option 2: Manual Setup
1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your values
   ```

3. **Setup Database**
   ```bash
   npx prisma migrate dev
   npx prisma generate
   ```

4. **Start Development**
   ```bash
   npm run dev
   ```

## 🛠️ Tech Stack

- **Frontend**: Next.js 14 + React 18 + TypeScript
- **Backend**: Next.js API Routes + Prisma ORM
- **Database**: PostgreSQL (Supabase/Railway/Neon recommended)
- **Authentication**: NextAuth.js (Google, GitHub, Email)
- **Styling**: Tailwind CSS + Framer Motion
- **Search**: PostgreSQL full-text search (no AI)

## 📦 What You Get

### ✅ Core Features
- **User Authentication**: Secure sign-up/sign-in
- **Book Management**: Add, edit, organize reading items
- **Reading Lists**: Create custom collections
- **Social Profiles**: Public/private reading profiles
- **Basic Search**: Fast text-based search and filtering
- **Manual Tagging**: Organize content with your own tags
- **Reading Analytics**: Basic stats (books read, streaks, etc.)
- **Following System**: Connect with other readers

### ❌ AI Features Removed
- ~~AI Summaries~~
- ~~AI Recommendations~~
- ~~Automatic Tagging~~
- ~~Semantic Search~~
- ~~Reading Predictions~~
- ~~AI-generated content~~

## 🗃️ Database Setup

### Free PostgreSQL Options

1. **Supabase** (Recommended)
   - Go to [supabase.com](https://supabase.com)
   - Create free account and new project
   - Copy connection string from Settings > Database

2. **Railway**
   - Go to [railway.app](https://railway.app)
   - Create new project with PostgreSQL service
   - Connection string provided automatically

3. **Neon**
   - Go to [neon.tech](https://neon.tech)
   - Create serverless PostgreSQL
   - Copy connection string from dashboard

4. **Local Development**
   ```bash
   # Using Docker
   docker run -d --name vow-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:15
   
   # Or install PostgreSQL locally
   createdb vow_dev
   ```

## 🔐 Authentication Setup

### Google OAuth (Free)
1. Go to [Google Cloud Console](https://console.developers.google.com/)
2. Create project and enable Google+ API
3. Create OAuth 2.0 credentials
4. Add callback URLs:
   - Development: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://yourdomain.com/api/auth/callback/google`

### GitHub OAuth (Free)
1. Go to GitHub Settings > Developer settings > OAuth Apps
2. Create new OAuth App
3. Add callback URLs:
   - Development: `http://localhost:3000/api/auth/callback/github`
   - Production: `https://yourdomain.com/api/auth/callback/github`

### Email Auth
- Works out of the box (no setup required)
- Uses NextAuth.js secure token-based auth

## 🚀 Deployment

### Vercel (Recommended)
1. Push code to GitHub
2. Connect repo to [Vercel](https://vercel.com)
3. Add environment variables in Vercel dashboard
4. Deploy automatically

### Railway
1. Push code to GitHub
2. Create new project on [Railway](https://railway.app)
3. Add PostgreSQL service
4. Set environment variables
5. Deploy

### Manual
```bash
npm run build
npm run prisma:migrate
npm run start
```

## 📊 Features Comparison

| Feature | AI Version | No-AI Version |
|---------|------------|---------------|
| User Auth | ✅ | ✅ |
| Book Tracking | ✅ | ✅ |
| Manual Tagging | ✅ | ✅ |
| Basic Search | ✅ | ✅ |
| Reading Analytics | ✅ | ✅ |
| Social Profiles | ✅ | ✅ |
| AI Summaries | ✅ | ❌ |
| AI Recommendations | ✅ | ❌ |
| Semantic Search | ✅ | ❌ |
| Auto-tagging | ✅ | ❌ |
| **API Costs** | **High** | **$0** |
| **Privacy** | **AI APIs** | **100% Private** |
| **Speed** | **API Delays** | **Instant** |

## 🔧 Customization

### Branding
- Edit colors in `tailwind.config.js`
- Modify layouts in `src/app/`
- Update homepage in `src/app/page.tsx`

### Database
- View/edit data: `npx prisma studio`
- Custom fields: Edit `prisma/schema.prisma`
- Add indexes for performance

### Features
- New item types: Update enums in schema
- OAuth providers: Configure in NextAuth
- Search filters: Extend `SearchItemsUseCase`

## 🐛 Troubleshooting

### Common Issues

**Database Connection Error**
```bash
# Check DATABASE_URL format
# Should be: postgresql://user:password@host:port/database
```

**OAuth Not Working**
```bash
# Verify callback URLs match exactly
# Check client ID and secret are correct
```

**Build Failures**
```bash
# Check TypeScript errors
npm run type-check

# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

## 📈 Performance Tips

1. **Database**: Use PostgreSQL with proper indexes
2. **Caching**: Add Redis for frequently accessed data
3. **CDN**: Use Vercel/Cloudflare for static assets
4. **Monitoring**: Add Sentry for error tracking

## 🤝 Contributing

This simplified version focuses on:
- Core functionality without AI dependencies
- Fast, reliable, privacy-focused features
- Easy deployment and maintenance

## 📄 License

MIT License - you can use, modify, and distribute freely.

---

**Ready to build your reading portfolio? Start with the [Deployment Guide](./DEPLOYMENT_GUIDE.md)!**

Questions? Check the [Setup Guide](./DEPLOYMENT_GUIDE.md) or create an issue.