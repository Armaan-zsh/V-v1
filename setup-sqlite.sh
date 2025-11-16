#!/bin/bash

# ==========================================
# SQLITE SETUP SCRIPT (ZERO DATABASE SETUP)
# ==========================================

echo "🗃️ Setting up SQLite version for immediate testing..."

# 1. Copy SQLite schema
echo "📝 Setting up SQLite schema..."
cp prisma/schema-sqlite.prisma prisma/schema.prisma

# 2. Copy SQLite environment
echo "⚙️ Setting up SQLite environment..."
cp .env.sqlite .env.local

# 3. Install dependencies if not already done
echo "📦 Installing dependencies..."
if [ ! -d "node_modules" ]; then
    pnpm install
fi

# 4. Generate Prisma client
echo "🔧 Generating Prisma client..."
npx prisma generate

# 5. Create database and run migrations
echo "🗄️ Creating database..."
npx prisma migrate dev --name init

echo ""
echo "✅ SQLite setup complete!"
echo ""
echo "🚀 To start your app:"
echo "   pnpm dev"
echo ""
echo "🎯 Your app will:"
echo "   - Run at http://localhost:3001"
echo "   - Use local SQLite database (no cloud needed)"
echo "   - Store data in dev.db file"
echo "   - Work offline"
echo ""
echo "📊 To view database:"
echo "   npx prisma studio"
echo ""
echo "🔄 To migrate to PostgreSQL later:"
echo "   - Use the PostgreSQL environment variables"
echo "   - Run migrations: npx prisma migrate deploy"