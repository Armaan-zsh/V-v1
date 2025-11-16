#!/bin/bash

# ==========================================
# VOW SIMPLIFIED SETUP SCRIPT
# Removes AI dependencies and sets up basic version
# ==========================================

set -e  # Exit on any error

echo "🚀 Setting up Vow Reading Portfolio (No AI Version)"
echo "=================================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: package.json not found. Run this script from the Vow project root."
    exit 1
fi

echo "📦 Backing up current files..."
if [ ! -d "backup" ]; then
    mkdir backup
fi

# Backup current files
cp package.json backup/package.json.backup 2>/dev/null || true
cp prisma/schema.prisma backup/schema.backup 2>/dev/null || true
cp .env.example backup/.env.example.backup 2>/dev/null || true

echo "🔄 Installing simplified dependencies..."

# Install simplified package.json
if [ -f "package-simple.json" ]; then
    cp package-simple.json package.json
    echo "✅ Updated package.json"
else
    echo "❌ package-simple.json not found!"
    exit 1
fi

# Install dependencies
echo "📥 Installing dependencies (this may take a few minutes)..."
npm install

echo "🗄️ Setting up simplified database schema..."
if [ -f "prisma/schema-simple.prisma" ]; then
    cp prisma/schema-simple.prisma prisma/schema.prisma
    echo "✅ Updated schema.prisma"
else
    echo "❌ schema-simple.prisma not found!"
    exit 1
fi

echo "⚙️ Setting up environment configuration..."
if [ -f ".env.example-simple" ]; then
    cp .env.example-simple .env.example
    echo "✅ Updated .env.example"
    
    # Create .env.local if it doesn't exist
    if [ ! -f ".env.local" ]; then
        cp .env.example .env.local
        echo "✅ Created .env.local from template"
        echo "⚠️  Please edit .env.local with your actual values!"
    fi
else
    echo "❌ .env.example-simple not found!"
    exit 1
fi

echo "🧹 Cleaning up AI dependencies..."
# Remove AI-related files
rm -rf src/infrastructure/ai/ 2>/dev/null || true
rm -rf src/core/use-cases/*AI* 2>/dev/null || true
rm -rf src/core/use-cases/*Semantic* 2>/dev/null || true
rm -rf src/core/use-cases/*Recommendation* 2>/dev/null || true
rm -rf src/core/use-cases/*Analyze* 2>/dev/null || true
rm -rf src/core/use-cases/*Summarize* 2>/dev/null || true
rm -rf src/core/use-cases/*Suggest* 2>/dev/null || true
rm -rf tests/*AI* 2>/dev/null || true
rm -rf tests/*semantic* 2>/dev/null || true

echo "🔧 Generating Prisma client..."
npx prisma generate

echo "🎯 Checking TypeScript..."
npm run type-check

echo ""
echo "✅ SETUP COMPLETE!"
echo "=================="
echo ""
echo "📋 Next Steps:"
echo "1. Edit .env.local with your database and OAuth credentials"
echo "2. Set up a PostgreSQL database (Supabase, Railway, or Neon recommended)"
echo "3. Run: npm run prisma:migrate"
echo "4. Start development: npm run dev"
echo ""
echo "📖 See DEPLOYMENT_GUIDE.md for detailed instructions"
echo ""
echo "🗃️ Database Migration:"
echo "  - If you have existing data, you'll need to migrate it manually"
echo "  - For fresh start: npm run prisma:migrate"
echo ""
echo "🔗 Free Services to Consider:"
echo "  - Database: https://supabase.com (PostgreSQL)"
echo "  - Hosting: https://vercel.com (Next.js)"
echo "  - OAuth: Google (console.developers.google.com)"
echo ""
echo "⚠️  Note: AI features have been removed"
echo "   - No OpenAI/Groq/Anthropic API keys needed"
echo "   - Manual tagging instead of AI suggestions"
echo "   - Basic search instead of semantic search"
echo "   - Manual curation instead of AI recommendations"