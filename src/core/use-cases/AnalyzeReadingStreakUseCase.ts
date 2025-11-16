import { z } from 'zod';
import { StreakPredictor, StreakAnalysisRequest } from '../../infrastructure/ai/StreakPredictor';
import { AppError } from '../../shared/errors/AppError';

export interface AnalyzeReadingStreakInput {
  userId: string;
  timeframe?: 'week' | 'month' | 'quarter';
  includePredictions?: boolean;
  includeRecommendations?: boolean;
  format?: 'detailed' | 'summary';
}

export interface AnalyzeReadingStreakOutput {
  streak: {
    current: number;
    longest: number;
    probability: number;
    prediction: {
      nextWeek: number;
      nextMonth: number;
    };
  };
  analysis: {
    pattern: string;
    consistency: number;
    trend: 'improving' | 'stable' | 'declining';
    riskLevel: 'low' | 'medium' | 'high';
  };
  insights: {
    totalReadingDays: number;
    averageSessionLength: number;
    mostProductiveDay: string;
    improvementAreas: string[];
    achievements: string[];
  };
  recommendations: string[];
  metadata: {
    timeframe: string;
    dataPoints: number;
    confidence: number;
    generatedAt: string;
  };
}

// Validation schema
export const AnalyzeReadingStreakInputSchema = z.object({
  userId: z.string().uuid(),
  timeframe: z.enum(['week', 'month', 'quarter']).default('month'),
  includePredictions: z.boolean().default(true),
  includeRecommendations: z.boolean().default(true),
  format: z.enum(['detailed', 'summary']).default('detailed'),
});

export class AnalyzeReadingStreakUseCase {
  private streakPredictor: StreakPredictor;

  constructor() {
    this.streakPredictor = new StreakPredictor();
  }

  async execute(input: AnalyzeReadingStreakInput): Promise<AnalyzeReadingStreakOutput> {
    try {
      // Validate input
      const validatedInput = AnalyzeReadingStreakInputSchema.parse(input);

      // Perform streak analysis
      const streakPrediction = await this.streakPredictor.analyzeAndPredict({
        userId: validatedInput.userId,
        timeframe: validatedInput.timeframe,
        includePredictions: validatedInput.includePredictions,
        includeRecommendations: validatedInput.includeRecommendations,
      });

      // Transform and enrich the data
      const output = this.transformAnalysis(
        streakPrediction,
        validatedInput.format,
        validatedInput.timeframe
      );

      return output;

    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      console.error('Error in AnalyzeReadingStreakUseCase:', error);
      throw new AppError('STREAK_ANALYSIS_FAILED', 'Failed to analyze reading streak');
    }
  }

  /**
   * Transform streak prediction into user-friendly output
   */
  private transformAnalysis(
    prediction: any,
    format: 'detailed' | 'summary',
    timeframe: string
  ): AnalyzeReadingStreakOutput {
    // Calculate longest streak from analysis data
    const longestStreak = this.calculateLongestStreak(prediction.analysis.weeklyPattern);

    // Determine trend based on monthly trend value
    const trend = this.determineTrend(prediction.analysis.monthlyTrend);

    // Determine risk level based on risk factors
    const riskLevel = this.determineRiskLevel(prediction.prediction.riskFactors);

    // Calculate confidence based on data quality and prediction certainty
    const confidence = this.calculateConfidence(prediction);

    // Format recommendations based on requested format
    const recommendations = format === 'summary'
      ? prediction.prediction.recommendations.slice(0, 3)
      : prediction.prediction.recommendations;

    return {
      streak: {
        current: prediction.prediction.currentStreak,
        longest: longestStreak,
        probability: prediction.prediction.probability,
        prediction: {
          nextWeek: this.predictStreakLength(prediction.prediction.predictedStreak, 7),
          nextMonth: this.predictStreakLength(prediction.prediction.predictedStreak, 30),
        },
      },
      analysis: {
        pattern: this.formatPattern(prediction.analysis.pattern),
        consistency: prediction.insights.consistencyScore,
        trend,
        riskLevel,
      },
      insights: {
        totalReadingDays: prediction.insights.activeDays,
        averageSessionLength: prediction.insights.avgSessionLength,
        mostProductiveDay: prediction.analysis.bestDays[0] || 'N/A',
        improvementAreas: this.identifyImprovementAreas(prediction),
        achievements: this.identifyAchievements(prediction, longestStreak),
      },
      recommendations,
      metadata: {
        timeframe,
        dataPoints: prediction.insights.totalDays,
        confidence,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Calculate longest streak from weekly pattern
   */
  private calculateLongestStreak(weeklyPattern: number[]): number {
    // This is a simplified calculation
    // In a real implementation, you'd analyze the actual historical data
    const activeDays = weeklyPattern.filter(d => d > 0).length;
    const weeks = Math.max(1, Math.floor(activeDays / 7));
    return Math.min(weeks * 7, activeDays); // Conservative estimate
  }

  /**
   * Determine trend from monthly trend value
   */
  private determineTrend(monthlyTrend: number): 'improving' | 'stable' | 'declining' {
    if (monthlyTrend > 0.1) return 'improving';
    if (monthlyTrend < -0.1) return 'declining';
    return 'stable';
  }

  /**
   * Determine risk level from risk factors
   */
  private determineRiskLevel(riskFactors: any[]): 'low' | 'medium' | 'high' {
    if (riskFactors.length === 0) return 'low';
    
    const highRiskCount = riskFactors.filter(r => r.severity === 'high').length;
    const mediumRiskCount = riskFactors.filter(r => r.severity === 'medium').length;
    
    if (highRiskCount > 0) return 'high';
    if (mediumRiskCount > 2) return 'high';
    if (mediumRiskCount > 0) return 'medium';
    return 'low';
  }

  /**
   * Calculate overall confidence in the analysis
   */
  private calculateConfidence(prediction: any): number {
    let confidence = 0.5; // Base confidence

    // Boost confidence based on data quantity
    if (prediction.insights.totalDays > 30) confidence += 0.2;
    else if (prediction.insights.totalDays > 14) confidence += 0.1;

    // Boost confidence based on consistency
    confidence += prediction.insights.consistencyScore * 0.3;

    // Adjust based on prediction certainty
    confidence += Math.abs(prediction.prediction.probability - 0.5) * 0.4;

    // Reduce confidence for high risk factors
    const highRiskFactors = prediction.prediction.riskFactors.filter((r: any) => r.severity === 'high').length;
    confidence -= highRiskFactors * 0.1;

    return Math.max(0.1, Math.min(0.95, confidence));
  }

  /**
   * Format pattern description for user display
   */
  private formatPattern(pattern: string): string {
    switch (pattern) {
      case 'consistent':
        return 'Consistent Reader';
      case 'improving':
        return 'Improving Trend';
      case 'declining':
        return 'Declining Trend';
      case 'irregular':
        return 'Irregular Pattern';
      default:
        return 'Developing Pattern';
    }
  }

  /**
   * Identify improvement areas based on analysis
   */
  private identifyImprovementAreas(prediction: any): string[] {
    const areas: string[] = [];

    // Check for low consistency
    if (prediction.insights.consistencyScore < 0.5) {
      areas.push('Consistency');
    }

    // Check for declining trend
    if (prediction.analysis.monthlyTrend < -0.2) {
      areas.push('Reading Frequency');
    }

    // Check for irregular patterns
    if (prediction.analysis.pattern === 'irregular') {
      areas.push('Schedule Regularity');
    }

    // Check for short sessions
    if (prediction.insights.avgSessionLength < 20) {
      areas.push('Session Length');
    }

    // Check for motivation issues
    if (prediction.insights.motivationLevel < 0.5) {
      areas.push('Motivation');
    }

    // Check for burnout risk
    if (prediction.insights.burnoutRisk > 0.6) {
      areas.push('Sustainable Pace');
    }

    return areas.slice(0, 3); // Top 3 areas
  }

  /**
   * Identify achievements and milestones
   */
  private identifyAchievements(prediction: any, longestStreak: number): string[] {
    const achievements: string[] = [];

    // Current streak achievements
    if (prediction.prediction.currentStreak >= 7) {
      achievements.push(`${prediction.prediction.currentStreak}-day reading streak`);
    }
    if (prediction.prediction.currentStreak >= 30) {
      achievements.push('Monthly reading consistency');
    }

    // Consistency achievements
    if (prediction.insights.consistencyScore > 0.8) {
      achievements.push('Highly consistent reader');
    }

    // Total activity achievements
    if (prediction.insights.activeDays > 20) {
      achievements.push('Active reader');
    }
    if (prediction.insights.totalReadingDays > 50) {
      achievements.push('Dedicated reader');
    }

    // Session length achievements
    if (prediction.insights.avgSessionLength > 45) {
      achievements.push('Deep reader');
    }

    // Trend achievements
    if (prediction.analysis.monthlyTrend > 0.3) {
      achievements.push('Improving reading habits');
    }

    return achievements.slice(0, 4); // Top 4 achievements
  }

  /**
   * Predict streak length for specific timeframe
   */
  private predictStreakLength(currentStreak: number, days: number): number {
    // Simple linear prediction based on current streak and trend
    const growthRate = 0.1; // 10% growth per week assumption
    const weeks = days / 7;
    
    return Math.round(currentStreak * (1 + growthRate * weeks));
  }

  /**
   * Get streak milestone information
   */
  getStreakMilestones(): Array<{ days: number; title: string; description: string }> {
    return [
      {
        days: 1,
        title: 'First Steps',
        description: 'Your reading journey begins',
      },
      {
        days: 7,
        title: 'Week Warrior',
        description: 'Consistent for a whole week',
      },
      {
        days: 14,
        title: 'Two-Week Champion',
        description: 'Half a month of dedication',
      },
      {
        days: 30,
        title: 'Monthly Master',
        description: 'A full month of consistency',
      },
      {
        days: 60,
        title: 'Two-Month Hero',
        description: 'Two months of dedication',
      },
      {
        days: 90,
        title: 'Quarterly Queen/King',
        description: 'Three months of commitment',
      },
      {
        days: 180,
        title: 'Half-Year Hero',
        description: 'Six months of consistent reading',
      },
      {
        days: 365,
        title: 'Year-Long Legend',
        description: 'A full year of reading excellence',
      },
    ];
  }

  /**
   * Calculate progress toward next milestone
   */
  calculateMilestoneProgress(currentStreak: number): {
    currentMilestone: any;
    nextMilestone: any;
    progress: number;
    daysRemaining: number;
  } {
    const milestones = this.getStreakMilestones();
    
    // Find current and next milestones
    let currentMilestone = milestones[0];
    let nextMilestone = milestones[1];
    
    for (let i = 0; i < milestones.length; i++) {
      if (currentStreak >= milestones[i].days) {
        currentMilestone = milestones[i];
        nextMilestone = milestones[i + 1] || milestones[i]; // Last milestone if at the end
      }
    }

    const progress = nextMilestone.days > currentMilestone.days 
      ? (currentStreak - currentMilestone.days) / (nextMilestone.days - currentMilestone.days)
      : 1;

    const daysRemaining = Math.max(0, nextMilestone.days - currentStreak);

    return {
      currentMilestone,
      nextMilestone,
      progress: Math.min(1, progress),
      daysRemaining,
    };
  }

  /**
   * Generate motivational message based on streak status
   */
  generateMotivationalMessage(streakData: any): string {
    const { currentStreak, probability } = streakData;

    if (currentStreak === 0) {
      return "Every journey begins with a single step. Start your reading streak today!";
    }

    if (currentStreak < 7) {
      return `Great start! You're ${7 - currentStreak} day${7 - currentStreak !== 1 ? 's' : ''} away from your first week milestone.`;
    }

    if (probability > 0.8) {
      return `Amazing! Your ${currentStreak}-day streak shows excellent consistency. Keep it up!`;
    } else if (probability > 0.6) {
      return `Good progress! Your ${currentStreak}-day streak shows dedication. Just ${Math.ceil((1 - probability) * 10)} more days to reach your next goal.`;
    } else {
      return `Don't give up! Your ${currentStreak}-day streak is valuable. A few more days will help establish a lasting habit.`;
    }
  }

  /**
   * Get personalized tips based on user's reading pattern
   */
  getPersonalizedTips(analysis: any): string[] {
    const tips: string[] = [];

    // Tips based on pattern type
    switch (analysis.pattern) {
      case 'irregular':
        tips.push("Try setting a specific time each day for reading");
        tips.push("Use phone reminders to build a reading routine");
        break;
      case 'declining':
        tips.push("Start with shorter sessions to rebuild momentum");
        tips.push("Choose easier or more engaging content temporarily");
        break;
      case 'consistent':
        tips.push("Consider gradually increasing your session length");
        tips.push("You're doing great! Share your success with others");
        break;
    }

    // Tips based on optimal reading time
    if (analysis.optimalReadingTime === 'Evening') {
      tips.push("Wind down your day with some reading before bed");
    } else if (analysis.optimalReadingTime === 'Morning') {
      tips.push("Start your day with reading to energize your mind");
    }

    // Tips based on consistency score
    if (analysis.consistency < 0.5) {
      tips.push("Focus on consistency over intensity");
      tips.push("Even 5 minutes of reading counts toward your streak");
    }

    return tips.slice(0, 3); // Top 3 tips
  }
}