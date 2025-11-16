#!/bin/bash

echo "📦 Preparing your Vow app for deployment..."

# Initialize git if not already done
if [ ! -d ".git" ]; then
    echo "🔧 Initializing Git repository..."
    git init
fi

# Add all files
echo "📁 Adding files to Git..."
git add .

# Create initial commit
echo "💾 Creating initial commit..."
git commit -m "Initial commit - Vow Reading Portfolio (AI-free version)"

# Show status
echo ""
echo "✅ Git repository ready!"
echo ""
echo "🚀 Next steps:"
echo "1. Create a GitHub account at https://github.com"
echo "2. Create a new repository named 'vow-reading-portfolio'"
echo "3. Push your code:"
echo ""
echo "   git remote add origin https://github.com/YOUR_USERNAME/vow-reading-portfolio.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo ""
echo "4. Deploy to Railway:"
echo "   - Go to https://railway.app"
echo "   - Sign up with GitHub"
echo "   - Click 'Deploy from GitHub repo'"
echo "   - Select your 'vow-reading-portfolio' repo"
echo ""
echo "🎯 Railway will handle everything automatically!"