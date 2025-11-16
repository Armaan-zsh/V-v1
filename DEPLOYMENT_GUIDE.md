# 🚀 Vow Reading Portfolio - Deployment Guide

## 🎯 Quick Start (5 Minutes)

### Option 1: Vercel + Supabase (Recommended)

1. **Clone and Setup**
   ```bash
   # Use the simplified files provided
   cp package-simple.json package.json
   cp .env.example-simple .env.example
   cp schema-simple.prisma prisma/schema.prisma
   
   npm install
   ```

2. **Setup Database**
   - Create free account at [Supabase](https://supabase.com)
   - Create new project
   - Copy connection string from Settings > Database

3. **Configure Environment**
   ```bash
   # .env.local
   DATABASE_URL="your-supabase-connection-string"
   NEXTAUTH_SECRET="your-secret-key-32-chars-min"
   GOOGLE_CLIENT_ID="your-google-oauth-client-id"  # Optional
   GOOGLE_CLIENT_SECRET="your-google-oauth-secret"  # Optional
   ```

4. **Deploy to Vercel**
   ```bash
   git init && git add . && git commit -m "Initial commit"
   # Push to GitHub, then connect repo to Vercel
   ```

### Option 2: Railway (All-in-One)

1. **Create Account** at [Railway.app](https://railway.app)
2. **New Project** → Deploy from GitHub repo
3. **Add PostgreSQL** service to your project
4. **Set Environment Variables** in Railway dashboard
5. **Deploy** - Railway handles everything automatically

### Option 3: Local Development

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Setup Database**
   ```bash
   # Using Docker
   docker run -d --name vow-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:15
   
   # Or use local PostgreSQL
   createdb vow_dev
   ```

3. **Environment Setup**
   ```bash
   cp .env.example-simple .env.local
   # Edit .env.local with your values
   ```

4. **Run Database Migrations**
   ```bash
   npx prisma migrate dev --name init
   npx prisma generate
   ```

5. **Start Development Server**
   ```bash
   npm run dev
   ```

## 📋 Environment Variables Explained

### Required (Must Set)
- `DATABASE_URL`: PostgreSQL connection string
- `NEXTAUTH_SECRET`: Random 32+ character string for session security

### Optional (Choose What You Need)
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`: For Google sign-in
- `GITHUB_CLIENT_ID` + `GITHUB_SECRET`: For GitHub sign-in
- `GOOGLE_BOOKS_API_KEY`: For better book metadata fetching
- `UPSTASH_REDIS_URL` + `UPSTASH_REDIS_TOKEN`: For caching and rate limiting

### Free Services Setup

#### Google OAuth (Sign-in with Google)
1. Go to [Google Cloud Console](https://console.developers.google.com/)
2. Create new project or select existing
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (development)
   - `https://yourdomain.com/api/auth/callback/google` (production)

#### GitHub OAuth (Sign-in with GitHub)
1. Go to GitHub Settings > Developer settings > OAuth Apps
2. New OAuth App
3. Authorization callback URL:
   - `http://localhost:3000/api/auth/callback/github` (development)
   - `https://yourdomain.com/api/auth/callback/github` (production)

#### Google Books API (Free book metadata)
1. Go to [Google Cloud Console](https://console.developers.google.com/)
2. Enable Books API
3. Create API key
4. Add to environment variables

## 🗃️ Database Setup

### Fresh Database (Recommended)
```bash
# Use the simplified schema
cp prisma/schema-simple.prisma prisma/schema.prisma
npx prisma migrate dev --name init
npx prisma db seed  # If you create a seed file
```

### Migration from AI Version
```bash
# Warning: This will lose AI-generated data
# Backup your data first!

# Option 1: Fresh start (recommended)
createdb vow_new
DATABASE_URL="postgresql://user:pass@localhost:5432/vow_new"
npx prisma migrate dev --name init

# Option 2: Manual migration (advanced)
# You'd need to write SQL to preserve non-AI data
```

## 🎨 Features (No AI Version)

### Core Features ✅
- User authentication (Google, GitHub, email)
- Add books, papers, articles manually
- Track reading status (want to read, reading, read, abandoned)
- Manual tagging system
- Reading lists and collections
- Public/private profiles
- Basic search and filtering
- Follow other readers
- Reading statistics (no AI predictions)

### Removed Features ❌
- AI summaries
- AI recommendations
- Automatic tagging
- Semantic search
- Reading streak predictions
- AI-generated content

### What's Different
- **Search**: Basic text search instead of AI-powered semantic search
- **Recommendations**: Manual curation and basic filtering
- **Tags**: You add tags manually instead of AI suggestions
- **Analytics**: Basic stats, no predictions
- **Speed**: Faster since no AI API calls

## 🛠️ Development Commands

```bash
# Development
npm run dev          # Start dev server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run linter

# Database
npm run prisma:migrate      # Create and apply migrations
npm run prisma:generate     # Generate Prisma client
npm run prisma:studio       # Open database browser
npm run prisma:reset        # Reset database (WARNING: deletes data)

# Testing
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Generate coverage report
```

## 🚀 Production Deployment

### Vercel (Recommended)
1. Push code to GitHub
2. Connect repo to Vercel
3. Set environment variables in Vercel dashboard
4. Deploy automatically on push

### Manual Deployment
```bash
npm run build
npm run prisma:migrate
npm run start
```

## 🔧 Customization

### Branding
- Edit `src/app/layout.tsx` for header/footer
- Update colors in `tailwind.config.js`
- Modify homepage in `src/app/page.tsx`

### Features
- Add new item types in `prisma/schema.prisma`
- Extend search filters in `SearchItemsUseCase`
- Add new OAuth providers via NextAuth

### Database
- Use `npx prisma studio` to manage data
- Add indexes for performance in schema.prisma
- Create seed data for testing

## 📞 Support

### Common Issues
1. **Database connection failed**: Check DATABASE_URL format
2. **OAuth not working**: Verify callback URLs and client credentials
3. **Build fails**: Run `npm run type-check` to find TypeScript errors

### Getting Help
- Check Vercel/hosting platform logs
- Run `npx prisma studio` to inspect database
- Use browser developer tools for frontend issues

---

**Ready to launch? Start with Option 1 (Vercel + Supabase) for the fastest deployment!**