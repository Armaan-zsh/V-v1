import { z } from 'zod';
import { Matrix } from 'ml-matrix';
import { OpenAIClient } from './OpenAIClient';
import { prisma } from '../database/prisma';
import { redis } from '../database/redis';

// Types for streak prediction
export interface ReadingSession {
  userId: string;
  date: Date;
  duration: number; // minutes
  itemsCompleted: number;
  itemsStarted: number;
  streakDay: boolean; // whether this contributes to streak
}

export interface StreakPrediction {
  prediction: {
    currentStreak: number;
    predictedStreak: number;
    probability: number; // 0-1 confidence
    riskFactors: RiskFactor[];
    recommendations: string[];
  };
  analysis: {
    pattern: 'consistent' | 'declining' | 'improving' | 'irregular';
    bestDays: string[]; // e.g., ['Monday', 'Wednesday']
    worstDays: string[];
    optimalReadingTime: string; // e.g., 'Evening', 'Morning'
    weeklyPattern: number[]; // 7 values representing average activity per day
    monthlyTrend: number; // -1 to 1, negative = declining, positive = improving
  };
  insights: {
    totalDays: number;
    activeDays: number;
    avgSessionLength: number;
    consistencyScore: number; // 0-1
    motivationLevel: number; // 0-1
    burnoutRisk: number; // 0-1
  };
}

export interface RiskFactor {
  type: 'gap' | 'decline' | 'irregularity' | 'fatigue';
  severity: 'low' | 'medium' | 'high';
  description: string;
  impact: number; // 0-1, how much this affects streak prediction
  mitigation: string;
}

export interface StreakAnalysisRequest {
  userId: string;
  timeframe?: 'week' | 'month' | 'quarter';
  includePredictions?: boolean;
  includeRecommendations?: boolean;
}

// Validation schemas
export const StreakAnalysisRequestSchema = z.object({
  userId: z.string().uuid(),
  timeframe: z.enum(['week', 'month', 'quarter']).default('month'),
  includePredictions: z.boolean().default(true),
  includeRecommendations: z.boolean().default(true),
});

export class StreakPredictor {
  private aiClient: OpenAIClient;
  private readonly MIN_READING_MINUTES = 15; // Minimum minutes to count as reading session
  private readonly STREAK_GRACE_PERIOD = 1; // Days allowed to miss without breaking streak

  constructor() {
    this.aiClient = new OpenAIClient();
  }

  /**
   * Analyze reading patterns and predict streak likelihood
   */
  async analyzeAndPredict(request: StreakAnalysisRequest): Promise<StreakPrediction> {
    try {
      // Validate input
      const validatedRequest = StreakAnalysisRequestSchema.parse(request);
      
      // Get reading data for analysis period
      const readingData = await this.getReadingData(validatedRequest.userId, validatedRequest.timeframe);
      
      if (readingData.length === 0) {
        return this.getEmptyAnalysis(validatedRequest.userId);
      }

      // Perform pattern analysis
      const patternAnalysis = await this.analyzeReadingPatterns(readingData);
      
      // Generate predictions if requested
      let prediction = null;
      if (validatedRequest.includePredictions) {
        prediction = await this.predictStreakContinuation(readingData, patternAnalysis);
      }

      // Generate insights
      const insights = this.generateInsights(readingData, patternAnalysis);

      // Generate recommendations if requested
      let recommendations: string[] = [];
      if (validatedRequest.includeRecommendations) {
        recommendations = await this.generateRecommendations(patternAnalysis, insights);
      }

      return {
        prediction: prediction || {
          currentStreak: patternAnalysis.currentStreak,
          predictedStreak: patternAnalysis.currentStreak,
          probability: 0.5,
          riskFactors: [],
          recommendations: [],
        },
        analysis: patternAnalysis,
        insights,
      };

    } catch (error) {
      console.error('Error in streak analysis:', error);
      throw error;
    }
  }

  /**
   * Get reading data for specified timeframe
   */
  private async getReadingData(userId: string, timeframe: 'week' | 'month' | 'quarter'): Promise<ReadingSession[]> {
    const endDate = new Date();
    const startDate = new Date();
    
    switch (timeframe) {
      case 'week':
        startDate.setDate(endDate.getDate() - 7);
        break;
      case 'month':
        startDate.setDate(endDate.getDate() - 30);
        break;
      case 'quarter':
        startDate.setDate(endDate.getDate() - 90);
        break;
    }

    // Get reading activities
    const activities = await prisma.readingActivity.findMany({
      where: {
        userId,
        createdAt: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        item: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // Group activities by date
    const sessionsByDate = new Map<string, ReadingSession>();
    
    for (const activity of activities) {
      const dateKey = activity.createdAt.toDateString();
      const existing = sessionsByDate.get(dateKey);
      
      const duration = activity.timeSpent;
      const isStreakDay = duration >= this.MIN_READING_MINUTES;
      
      if (existing) {
        // Update existing session
        existing.duration += duration;
        existing.itemsCompleted += activity.progress >= 0.9 ? 1 : 0;
        existing.itemsStarted += 1;
        existing.streakDay = existing.streakDay || isStreakDay;
      } else {
        // Create new session
        sessionsByDate.set(dateKey, {
          userId,
          date: activity.createdAt,
          duration,
          itemsCompleted: activity.progress >= 0.9 ? 1 : 0,
          itemsStarted: 1,
          streakDay: isStreakDay,
        });
      }
    }

    return Array.from(sessionsByDate.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /**
   * Analyze reading patterns to extract insights
   */
  private async analyzeReadingPatterns(data: ReadingSession[]): Promise<StreakPrediction['analysis']> {
    const now = new Date();
    let currentStreak = 0;
    let streakBroken = false;

    // Calculate current streak
    for (let i = data.length - 1; i >= 0; i--) {
      const session = data[i];
      const daysFromNow = Math.floor((now.getTime() - session.date.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysFromNow > this.STREAK_GRACE_PERIOD) {
        break; // Streak broken beyond grace period
      }
      
      if (session.streakDay && !streakBroken) {
        currentStreak++;
      } else if (!session.streakDay && currentStreak > 0) {
        streakBroken = true;
      }
    }

    // Calculate weekly pattern (0 = Sunday, 6 = Saturday)
    const weeklyPattern = new Array(7).fill(0);
    const dayCounts = new Array(7).fill(0);
    
    for (const session of data) {
      const dayOfWeek = session.date.getDay();
      weeklyPattern[dayOfWeek] += session.duration;
      dayCounts[dayOfWeek]++;
    }
    
    // Average out the weekly pattern
    for (let i = 0; i < 7; i++) {
      weeklyPattern[i] = dayCounts[i] > 0 ? weeklyPattern[i] / dayCounts[i] : 0;
    }

    // Find best and worst days
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const sortedDays = weeklyPattern
      .map((duration, index) => ({ day: dayNames[index], duration }))
      .sort((a, b) => b.duration - a.duration);
    
    const bestDays = sortedDays.slice(0, 3).map(d => d.day);
    const worstDays = sortedDays.slice(-3).map(d => d.day);

    // Determine optimal reading time (morning/afternoon/evening)
    const optimalReadingTime = this.determineOptimalReadingTime(data);

    // Calculate monthly trend
    const monthlyTrend = this.calculateMonthlyTrend(data);

    // Determine overall pattern
    const pattern = this.determineReadingPattern(data, monthlyTrend);

    return {
      currentStreak,
      predictedStreak: currentStreak, // Will be updated by prediction
      probability: 0.5, // Will be updated by prediction
      riskFactors: [], // Will be updated by prediction
      recommendations: [], // Will be updated by prediction
      pattern,
      bestDays,
      worstDays,
      optimalReadingTime,
      weeklyPattern,
      monthlyTrend,
    };
  }

  /**
   * Predict likelihood of streak continuation
   */
  private async predictStreakContinuation(
    data: ReadingSession[],
    patternAnalysis: StreakPrediction['analysis']
  ): Promise<StreakPrediction['prediction']> {
    
    try {
      // Analyze recent behavior (last 7 days)
      const recentData = data.filter(session => {
        const daysDiff = Math.floor((Date.now() - session.date.getTime()) / (1000 * 60 * 60 * 24));
        return daysDiff <= 7;
      });

      // Calculate various risk factors
      const riskFactors = this.identifyRiskFactors(data, recentData, patternAnalysis);
      
      // Calculate probability based on pattern consistency and risk factors
      let probability = this.calculateStreakProbability(data, recentData, riskFactors);
      
      // Use AI to refine prediction based on behavioral patterns
      if (recentData.length >= 3) {
        const aiPrediction = await this.getAIPrediction(data, recentData, riskFactors);
        if (aiPrediction) {
          // Blend AI prediction with statistical prediction
          probability = (probability * 0.6) + (aiPrediction * 0.4);
        }
      }

      // Calculate predicted streak length
      const predictedStreak = this.predictStreakLength(patternAnalysis.currentStreak, probability, riskFactors);

      // Generate recommendations based on risk factors
      const recommendations = this.generateStreakRecommendations(riskFactors, patternAnalysis);

      return {
        currentStreak: patternAnalysis.currentStreak,
        predictedStreak,
        probability: Math.max(0.1, Math.min(0.95, probability)),
        riskFactors,
        recommendations,
      };

    } catch (error) {
      console.error('Error predicting streak continuation:', error);
      
      // Fallback prediction
      return {
        currentStreak: patternAnalysis.currentStreak,
        predictedStreak: patternAnalysis.currentStreak,
        probability: 0.5,
        riskFactors: [],
        recommendations: ['Maintain consistent daily reading habits'],
      };
    }
  }

  /**
   * Identify risk factors that could break the streak
   */
  private identifyRiskFactors(
    allData: ReadingSession[],
    recentData: ReadingSession[],
    patternAnalysis: StreakPrediction['analysis']
  ): RiskFactor[] {
    const riskFactors: RiskFactor[] = [];

    // Check for declining trend
    if (patternAnalysis.monthlyTrend < -0.3) {
      riskFactors.push({
        type: 'decline',
        severity: 'high',
        description: 'Your reading activity has been declining over the past month',
        impact: 0.8,
        mitigation: 'Set smaller, achievable daily goals to rebuild momentum',
      });
    }

    // Check for irregular patterns
    const irregularity = this.calculateIrregularity(allData);
    if (irregularity > 0.7) {
      riskFactors.push({
        type: 'irregularity',
        severity: 'medium',
        description: 'Your reading schedule is highly irregular',
        impact: 0.6,
        mitigation: 'Establish a consistent daily reading routine',
      });
    }

    // Check for long gaps
    const longestGap = this.findLongestGap(allData);
    if (longestGap > 3) {
      riskFactors.push({
        type: 'gap',
        severity: longestGap > 7 ? 'high' : 'medium',
        description: `You had a gap of ${longestGap} days between reading sessions`,
        impact: Math.min(0.9, longestGap * 0.1),
        mitigation: 'Set reminders and build reading into your daily routine',
      });
    }

    // Check for potential burnout
    const avgSessionLength = allData.reduce((sum, s) => sum + s.duration, 0) / allData.length;
    if (avgSessionLength > 90) {
      riskFactors.push({
        type: 'fatigue',
        severity: 'medium',
        description: 'Your reading sessions are quite long, which might lead to fatigue',
        impact: 0.4,
        mitigation: 'Consider shorter, more frequent reading sessions',
      });
    }

    // Check recent activity decline
    if (recentData.length === 0) {
      riskFactors.push({
        type: 'gap',
        severity: 'high',
        description: 'No reading activity in the past week',
        impact: 0.9,
        mitigation: 'Start with just 5 minutes of reading today',
      });
    } else if (recentData.length < 3) {
      riskFactors.push({
        type: 'decline',
        severity: 'medium',
        description: 'Reduced reading frequency in recent days',
        impact: 0.6,
        mitigation: 'Try to maintain at least 3-4 reading days per week',
      });
    }

    return riskFactors;
  }

  /**
   * Calculate probability of streak continuation
   */
  private calculateStreakProbability(
    allData: ReadingSession[],
    recentData: ReadingSession[],
    riskFactors: RiskFactor[]
  ): number {
    let probability = 0.8; // Base probability

    // Adjust based on current streak length (longer streaks are harder to maintain)
    const currentStreak = this.calculateCurrentStreak(allData);
    probability -= Math.min(0.4, currentStreak * 0.02);

    // Adjust based on recent activity
    if (recentData.length === 0) {
      probability *= 0.2; // No recent activity
    } else if (recentData.length < 3) {
      probability *= 0.6; // Low recent activity
    } else if (recentData.length >= 5) {
      probability *= 1.2; // High recent activity
    }

    // Adjust based on risk factors
    for (const risk of riskFactors) {
      probability -= risk.impact * 0.15;
    }

    // Adjust based on consistency
    const consistency = this.calculateConsistencyScore(allData);
    probability += (consistency - 0.5) * 0.4;

    return Math.max(0.1, Math.min(0.95, probability));
  }

  /**
   * Get AI-enhanced prediction using OpenAI
   */
  private async getAIPrediction(
    allData: ReadingSession[],
    recentData: ReadingSession[],
    riskFactors: RiskFactor[]
  ): Promise<number | null> {
    try {
      // Prepare data for AI analysis
      const analysisData = {
        readingPattern: {
          totalSessions: allData.length,
          recentSessions: recentData.length,
          avgSessionLength: allData.reduce((sum, s) => sum + s.duration, 0) / allData.length,
          consistencyScore: this.calculateConsistencyScore(allData),
        },
        riskFactors: riskFactors.map(r => ({
          type: r.type,
          severity: r.severity,
          description: r.description,
        })),
        recentActivity: recentData.map(session => ({
          date: session.date.toISOString(),
          duration: session.duration,
          isStreakDay: session.streakDay,
        })),
      };

      const prompt = `
Analyze this user's reading streak data and predict the probability (0-1) they will continue their reading streak.
Consider patterns, risk factors, and behavioral indicators.

Data: ${JSON.stringify(analysisData, null, 2)}

Provide only a number between 0 and 1 representing the probability of streak continuation.`;

      const response = await this.aiClient.generateText({
        model: 'gpt-3.5-turbo',
        prompt,
        maxTokens: 10,
        temperature: 0.1,
      });

      const prediction = parseFloat(response.trim());
      return isNaN(prediction) ? null : Math.max(0.1, Math.min(0.95, prediction));

    } catch (error) {
      console.error('Error getting AI prediction:', error);
      return null;
    }
  }

  /**
   * Calculate current streak based on reading data
   */
  private calculateCurrentStreak(data: ReadingSession[]): number {
    const now = new Date();
    let streak = 0;
    let daysBack = 0;

    while (true) {
      const checkDate = new Date(now);
      checkDate.setDate(now.getDate() - daysBack);
      
      const sessionForDate = data.find(session => {
        const sessionDate = new Date(session.date);
        return sessionDate.toDateString() === checkDate.toDateString();
      });

      if (sessionForDate?.streakDay) {
        streak++;
        daysBack++;
      } else {
        if (daysBack <= this.STREAK_GRACE_PERIOD) {
          daysBack++;
          continue;
        }
        break;
      }
    }

    return streak;
  }

  /**
   * Calculate reading streak length prediction
   */
  private predictStreakLength(
    currentStreak: number,
    probability: number,
    riskFactors: RiskFactor[]
  ): number {
    // Base prediction on current streak and probability
    let predictedStreak = currentStreak;

    // Extend streak based on probability
    if (probability > 0.8) {
      predictedStreak += Math.floor(probability * 10); // Up to 10 more days
    } else if (probability > 0.6) {
      predictedStreak += Math.floor(probability * 5); // Up to 5 more days
    } else {
      predictedStreak += Math.floor(probability * 2); // Up to 2 more days
    }

    // Reduce prediction based on high-risk factors
    const highRiskFactors = riskFactors.filter(r => r.severity === 'high').length;
    predictedStreak = Math.max(currentStreak, predictedStreak - highRiskFactors);

    return predictedStreak;
  }

  /**
   * Generate streak recommendations
   */
  private generateStreakRecommendations(
    riskFactors: RiskFactor[],
    patternAnalysis: StreakPrediction['analysis']
  ): string[] {
    const recommendations: string[] = [];

    // Add specific recommendations based on risk factors
    for (const risk of riskFactors) {
      recommendations.push(risk.mitigation);
    }

    // Add general recommendations based on pattern
    if (patternAnalysis.pattern === 'irregular') {
      recommendations.push('Establish a specific time each day for reading');
    }

    if (patternAnalysis.bestDays.length > 0) {
      recommendations.push(`Try to read on ${patternAnalysis.bestDays[0]} when you're most active`);
    }

    if (patternAnalysis.optimalReadingTime !== 'Mixed') {
      recommendations.push(`Focus on ${patternAnalysis.optimalReadingTime.toLowerCase()} reading sessions`);
    }

    // Remove duplicates and limit to top recommendations
    return [...new Set(recommendations)].slice(0, 5);
  }

  /**
   * Generate overall insights from reading data
   */
  private generateInsights(
    data: ReadingSession[],
    patternAnalysis: StreakPrediction['analysis']
  ): StreakPrediction['insights'] {
    const totalDays = data.length;
    const activeDays = data.filter(s => s.streakDay).length;
    const avgSessionLength = data.reduce((sum, s) => sum + s.duration, 0) / data.length;
    const consistencyScore = this.calculateConsistencyScore(data);
    const motivationLevel = this.calculateMotivationLevel(data, patternAnalysis);
    const burnoutRisk = this.calculateBurnoutRisk(data);

    return {
      totalDays,
      activeDays,
      avgSessionLength: Math.round(avgSessionLength),
      consistencyScore,
      motivationLevel,
      burnoutRisk,
    };
  }

  /**
   * Determine optimal reading time based on session patterns
   */
  private determineOptimalReadingTime(data: ReadingSession[]): string {
    // For a more sophisticated implementation, you'd analyze time-of-day patterns
    // For now, return a default based on average session length
    const avgLength = data.reduce((sum, s) => sum + s.duration, 0) / data.length;
    
    if (avgLength < 20) return 'Short sessions';
    if (avgLength > 60) return 'Long sessions';
    return 'Mixed';
  }

  /**
   * Calculate monthly trend (-1 to 1)
   */
  private calculateMonthlyTrend(data: ReadingSession[]): number {
    if (data.length < 10) return 0;

    // Split data into two halves
    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint);
    const secondHalf = data.slice(midpoint);

    const firstHalfAvg = firstHalf.reduce((sum, s) => sum + s.duration, 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((sum, s) => sum + s.duration, 0) / secondHalf.length;

    const change = (secondHalfAvg - firstHalfAvg) / firstHalfAvg;
    return Math.max(-1, Math.min(1, change));
  }

  /**
   * Determine overall reading pattern
   */
  private determineReadingPattern(data: ReadingSession[], monthlyTrend: number): 'consistent' | 'declining' | 'improving' | 'irregular' {
    const consistency = this.calculateConsistencyScore(data);
    
    if (consistency > 0.8) return 'consistent';
    if (monthlyTrend > 0.3) return 'improving';
    if (monthlyTrend < -0.3) return 'declining';
    return 'irregular';
  }

  /**
   * Calculate pattern irregularity (0-1, higher = more irregular)
   */
  private calculateIrregularity(data: ReadingSession[]): number {
    if (data.length < 2) return 0;

    // Calculate gaps between reading days
    const gaps: number[] = [];
    let lastReadingDay = -1;

    for (let i = 0; i < data.length; i++) {
      const dayOfYear = Math.floor(data[i].date.getTime() / (1000 * 60 * 60 * 24));
      if (data[i].streakDay) {
        if (lastReadingDay !== -1) {
          gaps.push(dayOfYear - lastReadingDay);
        }
        lastReadingDay = dayOfYear;
      }
    }

    if (gaps.length === 0) return 0;

    const avgGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const stdDev = Math.sqrt(
      gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length
    );

    return Math.min(1, stdDev / avgGap);
  }

  /**
   * Find longest gap between reading sessions
   */
  private findLongestGap(data: ReadingSession[]): number {
    if (data.length < 2) return 0;

    const readingDays = data.filter(s => s.streakDay).map(s => 
      Math.floor(s.date.getTime() / (1000 * 60 * 60 * 24))
    ).sort((a, b) => a - b);

    let maxGap = 0;
    for (let i = 1; i < readingDays.length; i++) {
      const gap = readingDays[i] - readingDays[i - 1];
      maxGap = Math.max(maxGap, gap);
    }

    return maxGap;
  }

  /**
   * Calculate consistency score (0-1)
   */
  private calculateConsistencyScore(data: ReadingSession[]): number {
    if (data.length < 2) return 0;

    const readingDays = data.filter(s => s.streakDay);
    if (readingDays.length < 2) return 0;

    // Calculate gaps between consecutive reading days
    const gaps: number[] = [];
    const sortedReadingDays = readingDays
      .map(s => Math.floor(s.date.getTime() / (1000 * 60 * 60 * 24)))
      .sort((a, b) => a - b);

    for (let i = 1; i < sortedReadingDays.length; i++) {
      gaps.push(sortedReadingDays[i] - sortedReadingDays[i - 1]);
    }

    if (gaps.length === 0) return 0;

    // Consistency is inverse of gap variability
    const avgGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const stdDev = Math.sqrt(
      gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length
    );

    return Math.max(0, 1 - (stdDev / Math.max(avgGap, 1)));
  }

  /**
   * Calculate motivation level (0-1)
   */
  private calculateMotivationLevel(
    data: ReadingSession[],
    patternAnalysis: StreakPrediction['analysis']
  ): number {
    // Based on recent activity, trend, and engagement
    const recentData = data.slice(-7);
    const hasRecentActivity = recentData.length > 0;
    const isImproving = patternAnalysis.monthlyTrend > 0;
    const hasStreak = patternAnalysis.currentStreak > 0;
    const highEngagement = recentData.some(s => s.duration > 30);

    let motivation = 0.3; // Base motivation

    if (hasRecentActivity) motivation += 0.2;
    if (isImproving) motivation += 0.2;
    if (hasStreak) motivation += 0.1;
    if (highEngagement) motivation += 0.1;

    return Math.min(1, motivation);
  }

  /**
   * Calculate burnout risk (0-1)
   */
  private calculateBurnoutRisk(data: ReadingSession[]): number {
    if (data.length === 0) return 0;

    const avgSessionLength = data.reduce((sum, s) => sum + s.duration, 0) / data.length;
    const totalTime = data.reduce((sum, s) => sum + s.duration, 0);
    
    // Risk factors: very long sessions, very high total time
    let risk = 0;

    if (avgSessionLength > 90) risk += 0.3; // Very long sessions
    if (avgSessionLength > 60) risk += 0.2; // Long sessions
    if (totalTime > 600) risk += 0.2; // High total time (10+ hours)

    return Math.min(1, risk);
  }

  /**
   * Get empty analysis for users with no reading data
   */
  private async getEmptyAnalysis(userId: string): Promise<StreakPrediction> {
    return {
      prediction: {
        currentStreak: 0,
        predictedStreak: 0,
        probability: 0.5,
        riskFactors: [
          {
            type: 'gap',
            severity: 'medium',
            description: 'No reading activity recorded yet',
            impact: 1.0,
            mitigation: 'Start your reading journey with just 5 minutes today',
          },
        ],
        recommendations: [
          'Set a daily reading goal (even 5 minutes)',
          'Choose a consistent time for reading',
          'Start with short, manageable sessions',
        ],
      },
      analysis: {
        currentStreak: 0,
        predictedStreak: 0,
        probability: 0.5,
        riskFactors: [],
        recommendations: [],
        pattern: 'irregular',
        bestDays: [],
        worstDays: [],
        optimalReadingTime: 'Mixed',
        weeklyPattern: new Array(7).fill(0),
        monthlyTrend: 0,
      },
      insights: {
        totalDays: 0,
        activeDays: 0,
        avgSessionLength: 0,
        consistencyScore: 0,
        motivationLevel: 0.5,
        burnoutRisk: 0,
      },
    };
  }

  /**
   * Generate recommendations using AI for personalized advice
   */
  private async generateRecommendations(
    patternAnalysis: StreakPrediction['analysis'],
    insights: StreakPrediction['insights']
  ): Promise<string[]> {
    try {
      const prompt = `
Based on this reading analysis, provide 3-5 specific, actionable recommendations to improve reading consistency:

Pattern: ${patternAnalysis.pattern}
Current Streak: ${patternAnalysis.currentStreak}
Monthly Trend: ${patternAnalysis.monthlyTrend > 0 ? 'Improving' : 'Declining'}
Best Days: ${patternAnalysis.bestDays.join(', ')}
Consistency Score: ${insights.consistencyScore.toFixed(2)}
Motivation Level: ${insights.motivationLevel.toFixed(2)}
Burnout Risk: ${insights.burnoutRisk.toFixed(2)}

Provide concise, practical recommendations.`;

      const response = await this.aiClient.generateText({
        model: 'gpt-3.5-turbo',
        prompt,
        maxTokens: 200,
        temperature: 0.7,
      });

      // Parse recommendations from response
      const recommendations = response
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 10 && !line.includes('Based on'))
        .slice(0, 5);

      return recommendations.length > 0 ? recommendations : [
        'Maintain consistent daily reading habits',
        'Set realistic daily goals',
        'Track your progress regularly',
      ];

    } catch (error) {
      console.error('Error generating AI recommendations:', error);
      return [
        'Maintain consistent daily reading habits',
        'Set realistic daily goals',
        'Track your progress regularly',
      ];
    }
  }
}