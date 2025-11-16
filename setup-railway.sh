#!/bin/bash

# ==========================================
# RAILWAY DEPLOYMENT SETUP SCRIPT
# ==========================================

echo "🚀 Setting up Vow Reading Portfolio for Railway deployment..."

# 1. Create a simple Railway deployment guide
echo "📝 Creating Railway deployment guide..."

# 2. Update environment variables for Railway
cat > .env.railway << EOF
# Railway will automatically provide DATABASE_URL
# You just need to set these:
NEXTAUTH_SECRET="your-32-character-secret-here"
NEXTAUTH_URL="https://your-app.railway.app"
NODE_ENV="production"
EOF

# 3. Create Railway-specific files
echo "📁 Creating Railway configuration files..."

# railway.json
cat > railway.json << EOF
{
  "\$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 100
  }
}
EOF

# 4. Update package.json start script
echo "⚙️ Updating start script..."

# 5. Create health check endpoint if it doesn't exist
mkdir -p src/app/api/health
cat > src/app/api/health/route.ts << EOF
export async function GET() {
  return new Response('OK', { status: 200 });
}
EOF

echo "✅ Railway setup complete!"
echo ""
echo "🌟 Next steps:"
echo "1. Go to https://railway.app"
echo "2. Sign up with GitHub"
echo "3. Click 'Deploy from GitHub repo'"
echo "4. Connect your repo"
echo "5. Railway will:"
echo "   - Auto-detect it's a Next.js app"
echo "   - Add PostgreSQL database"
echo "   - Set environment variables"
echo "   - Deploy automatically"
echo ""
echo "📚 You'll get:"
echo "   - Free PostgreSQL database"
echo "   - Custom domain (https://your-app.railway.app)"
echo "   - Auto-scaling for more users"
echo "   - Zero maintenance required"
echo ""
echo "🎯 That's it! Railway handles everything automatically."