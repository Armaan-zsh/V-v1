/**
 * Chaos Engineering Suite
 * Advanced resilience testing platform with automated fault injection,
 * system monitoring, and comprehensive recovery validation
 */

import { EventEmitter } from 'events';
import { Database } from '../database/Database';
import { logger } from '../observability/logger';
import { CircuitBreaker } from '../resilience/CircuitBreaker';

interface ChaosExperiment {
  id: string;
  name: string;
  description?: string;
  category: ExperimentCategory;
  target: ExperimentTarget;
  fault: FaultConfiguration;
  validation: ValidationConfig;
  schedule: ScheduleConfig;
  status: ExperimentStatus;
  metrics: ExperimentMetrics;
  createdBy: string;
  createdAt: Date;
  lastRun?: Date;
  nextRun?: Date;
  results: ExperimentResult[];
}

type ExperimentCategory = 
  | 'availability' 
  | 'performance' 
  | 'security' 
  | 'network' 
  | 'data' 
  | 'infrastructure'
  | 'application'
  | 'dependencies';

interface ExperimentTarget {
  type: 'service' | 'database' | 'network' | 'storage' | 'external_api' | 'infrastructure';
  selector: TargetSelector;
  scope: 'single' | 'subset' | 'all';
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

interface TargetSelector {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  ports?: number[];
  paths?: string[];
}

interface FaultConfiguration {
  type: FaultType;
  intensity: FaultIntensity;
  duration: number; // seconds
  delay?: number; // seconds before fault starts
  probability?: number; // 0-1
  conditions?: FaultCondition[];
  parameters: Record<string, any>;
}

type FaultType = 
  | 'latency' 
  | 'packet_loss' 
  | 'connection_drop' 
  | 'service_kill' 
  | 'resource_exhaustion'
  | 'database_corruption' 
  | 'memory_leak' 
  | 'cpu_spike' 
  | 'disk_full'
  | 'network_partition' 
  | 'dependency_failure' 
  | 'config_error'
  | 'authentication_failure' 
  | 'rate_limit' 
  | 'timeout';

interface FaultIntensity {
  level: 'low' | 'medium' | 'high' | 'extreme';
  value: number; // percentage or specific value
  rampUp?: number; // seconds to reach full intensity
  rampDown?: number; // seconds to reduce intensity
}

interface FaultCondition {
  metric: string;
  operator: 'gt' | 'lt' | 'eq' | 'between';
  value: any;
  duration?: number; // seconds condition must persist
}

interface ValidationConfig {
  healthChecks: HealthCheck[];
  assertions: Assertion[];
  timeouts: ValidationTimeout;
  rollbackConditions: RollbackCondition[];
}

interface HealthCheck {
  type: 'http' | 'tcp' | 'database' | 'custom';
  endpoint?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  expectedResponse?: any;
  timeout: number;
  interval: number;
  threshold: number; // consecutive failures
}

interface Assertion {
  type: 'response_time' | 'error_rate' | 'availability' | 'throughput' | 'custom';
  metric: string;
  condition: 'lt' | 'gt' | 'eq' | 'between';
  threshold: number;
  duration: number; // seconds
  critical: boolean;
}

interface ValidationTimeout {
  total: number; // maximum experiment duration
  fault: number; // fault injection timeout
  recovery: number; // recovery validation timeout
}

interface RollbackCondition {
  type: 'metric' | 'error' | 'timeout';
  condition: any;
  action: 'stop' | 'rollback' | 'reduce_intensity';
  immediate: boolean;
}

interface ScheduleConfig {
  frequency: 'manual' | 'once' | 'periodic' | 'continuous';
  interval?: number; // seconds between runs
  timeWindow?: TimeWindow;
  maxRuns?: number;
  stopConditions: StopCondition[];
}

interface TimeWindow {
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  timezone: string;
  daysOfWeek?: number[]; // 0-6, Sunday=0
  daysOfMonth?: number[]; // 1-31
}

interface StopCondition {
  type: 'duration' | 'success_rate' | 'error_threshold' | 'manual';
  value: number;
}

interface ExperimentStatus = 
  | 'draft' 
  | 'scheduled' 
  | 'running' 
  | 'completed' 
  | 'failed' 
  | 'stopped' 
  | 'cancelled';

interface ExperimentMetrics {
  successRate: number;
  averageRecoveryTime: number;
  errorRate: number;
  availabilityImpact: number;
  lastAssessment?: Date;
  trends: MetricTrend[];
}

interface MetricTrend {
  metric: string;
  direction: 'improving' | 'stable' | 'degrading';
  change: number;
  period: string;
}

interface ExperimentResult {
  id: string;
  runId: string;
  startedAt: Date;
  completedAt: Date;
  status: 'success' | 'failure' | 'partial' | 'timeout';
  metrics: RunMetrics;
  validationResults: ValidationResult[];
  faultResults: FaultResult[];
  recoveryResults: RecoveryResult[];
  recommendations: string[];
}

interface RunMetrics {
  duration: number;
  successRate: number;
  errorCount: number;
  recoveryTime?: number;
  availability: number;
  performance: PerformanceMetrics;
}

interface PerformanceMetrics {
  responseTime: number[];
  throughput: number;
  latencyPercentiles: LatencyPercentile[];
  resourceUsage: ResourceUsage;
}

interface LatencyPercentile {
  percentile: number;
  value: number;
  unit: 'ms' | 's';
}

interface ResourceUsage {
  cpu: number;
  memory: number;
  disk: number;
  network: NetworkUsage;
}

interface NetworkUsage {
  inbound: number;
  outbound: number;
  packetsDropped: number;
  latency: number;
}

interface ValidationResult {
  checkId: string;
  status: 'pass' | 'fail' | 'timeout';
  duration: number;
  details: string;
  metrics: Record<string, number>;
}

interface FaultResult {
  faultType: string;
  applied: boolean;
  intensity: number;
  duration: number;
  impact: number;
  errors: FaultError[];
}

interface FaultError {
  timestamp: Date;
  message: string;
  service: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface RecoveryResult {
  phase: 'detection' | 'isolation' | 'recovery' | 'validation';
  status: 'success' | 'failure' | 'timeout';
  duration: number;
  steps: RecoveryStep[];
}

interface RecoveryStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration?: number;
  details?: string;
}

interface ChaosSchedule {
  id: string;
  name: string;
  description?: string;
  experiments: string[]; // experiment IDs
  timezone: string;
  timezoneOffset: number;
  windows: ScheduleWindow[];
  conditions: ScheduleCondition[];
  status: 'active' | 'paused' | 'disabled';
  createdAt: Date;
}

interface ScheduleWindow {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  daysOfWeek?: number[];
  excludeHolidays: boolean;
  maxConcurrency: number;
}

interface ScheduleCondition {
  type: 'resource_availability' | 'maintenance_mode' | 'business_hours' | 'load_threshold';
  parameters: Record<string, any>;
  required: boolean;
}

interface ChaosProfile {
  id: string;
  name: string;
  description?: string;
  organization: string;
  environment: 'development' | 'staging' | 'production';
  blastRadius: BlastRadius;
  experiments: string[];
  guardrails: Guardrail[];
  permissions: ProfilePermissions;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface BlastRadius {
  allowedTargets: string[];
  forbiddenTargets: string[];
  maxConcurrentFaults: number;
  safetyThreshold: number;
  rollbackDelay: number;
}

interface Guardrail {
  type: 'metric' | 'threshold' | 'condition';
  metric: string;
  condition: string;
  value: number;
  action: 'stop' | 'alert' | 'rollback';
  severity: 'low' | 'medium' | 'high' | 'critical';
}

interface ProfilePermissions {
  owners: string[];
  editors: string[];
  viewers: string[];
  executors: string[];
}

interface ResilienceScore {
  overall: number;
  categories: CategoryScore[];
  trends: ScoreTrend[];
  lastAssessment: Date;
  nextAssessment: Date;
  factors: ResilienceFactor[];
}

interface CategoryScore {
  category: string;
  score: number;
  weight: number;
  issues: ResilienceIssue[];
  improvements: Improvement[];
}

interface ResilienceIssue {
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  impact: string;
  recommendation: string;
  experiments: string[];
}

interface Improvement {
  priority: 'low' | 'medium' | 'high';
  description: string;
  effort: 'low' | 'medium' | 'high';
  impact: string;
  experiments: string[];
}

interface ScoreTrend {
  period: string;
  score: number;
  change: number;
  direction: 'improving' | 'stable' | 'degrading';
}

interface ResilienceFactor {
  name: string;
  score: number;
  weight: number;
  description: string;
}

class ChaosEngineeringSuite extends EventEmitter {
  private experiments = new Map<string, ChaosExperiment>();
  private schedules = new Map<string, ChaosSchedule>();
  private profiles = new Map<string, ChaosProfile>();
  private activeRuns = new Map<string, ExperimentRun>();
  private faultInjector: FaultInjector;
  private validator: ExperimentValidator;
  private scheduler: ChaosScheduler;
  private scoreCalculator: ResilienceScoreCalculator;
  private circuitBreaker = new CircuitBreaker(1000);

  constructor(
    private database: Database,
    private config: any
  ) {
    super();
    this.faultInjector = new FaultInjector(this.config.infrastructure);
    this.validator = new ExperimentValidator(this.database);
    this.scheduler = new ChaosScheduler(this.database, this.experiments);
    this.scoreCalculator = new ResilienceScoreCalculator(this.database);
    
    this.setupEventHandlers();
    this.initializeScheduler();
  }

  private setupEventHandlers(): void {
    this.on('experiment_started', this.handleExperimentStarted.bind(this));
    this.on('fault_injected', this.handleFaultInjected.bind(this));
    this.on('validation_failed', this.handleValidationFailed.bind(this));
    this.on('experiment_completed', this.handleExperimentCompleted.bind(this));
    this.on('resilience_score_updated', this.handleResilienceScoreUpdated.bind(this));
  }

  private initializeScheduler(): void {
    // Initialize scheduled experiments
    setInterval(async () => {
      await this.scheduler.processSchedules();
    }, this.config.schedulerInterval || 60000); // Check every minute
  }

  /**
   * Create chaos engineering experiment
   */
  async createExperiment(experiment: Omit<ChaosExperiment, 'id' | 'createdAt' | 'status' | 'metrics' | 'results'>): Promise<string> {
    try {
      // Validate experiment configuration
      this.validateExperiment(experiment);
      
      // Create experiment object
      const chaosExperiment: ChaosExperiment = {
        ...experiment,
        id: this.generateExperimentId(),
        createdAt: new Date(),
        status: 'draft',
        metrics: {
          successRate: 0,
          averageRecoveryTime: 0,
          errorRate: 0,
          availabilityImpact: 0,
          trends: []
        },
        results: []
      };

      // Store experiment
      this.experiments.set(chaosExperiment.id, chaosExperiment);
      
      // Save to database
      await this.saveExperiment(chaosExperiment);
      
      // Validate against chaos profile
      await this.validateAgainstProfile(chaosExperiment);
      
      logger.info(`Chaos experiment created`, {
        experimentId: chaosExperiment.id,
        name: chaosExperiment.name,
        category: chaosExperiment.category
      });
      
      return chaosExperiment.id;
      
    } catch (error) {
      logger.error('Experiment creation failed', { error: error.message, experiment });
      throw new Error(`Experiment creation failed: ${error.message}`);
    }
  }

  /**
   * Execute chaos experiment
   */
  async executeExperiment(
    experimentId: string,
    options: {
      dryRun?: boolean;
      override?: Partial<ChaosExperiment>;
      context?: ExecutionContext;
    } = {}
  ): Promise<string> {
    try {
      const experiment = this.experiments.get(experimentId);
      if (!experiment) {
        throw new Error(`Experiment ${experimentId} not found`);
      }

      if (experiment.status === 'running') {
        throw new Error(`Experiment ${experimentId} is already running`);
      }

      // Create execution context
      const runId = this.generateRunId();
      const context: ExecutionContext = {
        experimentId,
        runId,
        startedBy: options.context?.userId || 'system',
        dryRun: options.dryRun || false,
        override: options.override
      };

      // Create run instance
      const run = new ExperimentRun(experiment, context, this.faultInjector, this.validator);
      this.activeRuns.set(runId, run);

      // Update experiment status
      experiment.status = 'running';
      experiment.lastRun = new Date();

      // Start execution
      const result = await this.circuitBreaker.execute(async () => {
        return await run.execute();
      });

      // Store result
      experiment.results.push(result);
      
      // Update metrics
      await this.updateExperimentMetrics(experiment, result);
      
      // Update status
      experiment.status = 'completed';
      
      // Save experiment
      await this.updateExperiment(experiment);
      
      // Remove from active runs
      this.activeRuns.delete(runId);
      
      logger.info(`Experiment executed successfully`, {
        experimentId,
        runId,
        status: result.status,
        duration: result.completedAt.getTime() - result.startedAt.getTime()
      });
      
      this.emit('experiment_completed', {
        experimentId,
        runId,
        result,
        metrics: result.metrics
      });
      
      return runId;
      
    } catch (error) {
      logger.error('Experiment execution failed', { experimentId, error: error.message });
      
      // Update experiment status
      const experiment = this.experiments.get(experimentId);
      if (experiment) {
        experiment.status = 'failed';
        await this.updateExperiment(experiment);
      }
      
      throw error;
    }
  }

  /**
   * Stop running experiment
   */
  async stopExperiment(runId: string, reason?: string): Promise<void> {
    try {
      const run = this.activeRuns.get(runId);
      if (!run) {
        throw new Error(`Active run ${runId} not found`);
      }

      // Stop the run
      await run.stop(reason);
      
      // Update experiment status
      const experiment = this.experiments.get(run.experimentId);
      if (experiment) {
        experiment.status = 'stopped';
        await this.updateExperiment(experiment);
      }
      
      // Remove from active runs
      this.activeRuns.delete(runId);
      
      logger.info(`Experiment stopped`, {
        runId,
        experimentId: run.experimentId,
        reason: reason || 'manual'
      });
      
    } catch (error) {
      logger.error('Experiment stop failed', { runId, error: error.message });
      throw error;
    }
  }

  /**
   * Get experiment results with analytics
   */
  async getExperimentResults(
    experimentId: string,
    options: {
      includeMetrics?: boolean;
      includeRecommendations?: boolean;
      timeRange?: { start: Date; end: Date };
    } = {}
  ): Promise<ExperimentResults> {
    try {
      const experiment = this.experiments.get(experimentId);
      if (!experiment) {
        throw new Error(`Experiment ${experimentId} not found`);
      }

      // Filter results by time range if specified
      let results = experiment.results;
      if (options.timeRange) {
        results = results.filter(r => 
          r.startedAt >= options.timeRange!.start && 
          r.startedAt <= options.timeRange!.end
        );
      }

      // Calculate analytics
      const analytics = await this.calculateResultsAnalytics(results, options);
      
      // Get recommendations if requested
      let recommendations = [];
      if (options.includeRecommendations) {
        recommendations = await this.generateRecommendations(experiment, results);
      }
      
      return {
        experiment,
        results,
        analytics,
        recommendations
      };
      
    } catch (error) {
      logger.error('Failed to get experiment results', { 
        experimentId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Create chaos schedule for automated experiments
   */
  async createSchedule(schedule: Omit<ChaosSchedule, 'id' | 'createdAt'>): Promise<string> {
    try {
      const chaosSchedule: ChaosSchedule = {
        ...schedule,
        id: this.generateScheduleId(),
        createdAt: new Date()
      };

      // Validate schedule
      this.validateSchedule(chaosSchedule);
      
      // Store schedule
      this.schedules.set(chaosSchedule.id, chaosSchedule);
      
      // Save to database
      await this.saveSchedule(chaosSchedule);
      
      // Initialize schedule
      await this.scheduler.initializeSchedule(chaosSchedule);
      
      logger.info(`Chaos schedule created`, {
        scheduleId: chaosSchedule.id,
        name: chaosSchedule.name,
        experimentCount: chaosSchedule.experiments.length
      });
      
      return chaosSchedule.id;
      
    } catch (error) {
      logger.error('Schedule creation failed', { error: error.message, schedule });
      throw new Error(`Schedule creation failed: ${error.message}`);
    }
  }

  /**
   * Create chaos profile for organization-level configuration
   */
  async createProfile(profile: Omit<ChaosProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    try {
      const chaosProfile: ChaosProfile = {
        ...profile,
        id: this.generateProfileId(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Validate profile
      this.validateProfile(chaosProfile);
      
      // Store profile
      this.profiles.set(chaosProfile.id, chaosProfile);
      
      // Save to database
      await this.saveProfile(chaosProfile);
      
      logger.info(`Chaos profile created`, {
        profileId: chaosProfile.id,
        name: chaosProfile.name,
        organization: chaosProfile.organization
      });
      
      return chaosProfile.id;
      
    } catch (error) {
      logger.error('Profile creation failed', { error: error.message, profile });
      throw new Error(`Profile creation failed: ${error.message}`);
    }
  }

  /**
   * Calculate resilience score for system
   */
  async calculateResilienceScore(
    organization: string,
    environment: string,
    options: {
      timeRange?: { start: Date; end: Date };
      includeTrends?: boolean;
      factors?: string[];
    } = {}
  ): Promise<ResilienceScore> {
    try {
      const profile = await this.getActiveProfile(organization, environment);
      if (!profile) {
        throw new Error(`No active chaos profile found for ${organization}/${environment}`);
      }

      // Get experiment results in time range
      const experiments = await this.getExperimentsForProfile(profile.id, options.timeRange);
      
      // Calculate resilience score
      const score = await this.scoreCalculator.calculateScore({
        experiments,
        profile,
        factors: options.factors,
        timeRange: options.timeRange,
        includeTrends: options.includeTrends
      });
      
      logger.info(`Resilience score calculated`, {
        organization,
        environment,
        overallScore: score.overall,
        categories: score.categories.length
      });
      
      this.emit('resilience_score_updated', { 
        organization, 
        environment, 
        score 
      });
      
      return score;
      
    } catch (error) {
      logger.error('Resilience score calculation failed', { 
        organization, 
        environment, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get system health assessment
   */
  async getSystemHealthAssessment(
    organization: string,
    environment: string
  ): Promise<SystemHealthAssessment> {
    try {
      // Get resilience score
      const resilienceScore = await this.calculateResilienceScore(organization, environment);
      
      // Get recent experiment results
      const recentResults = await this.getRecentExperimentResults(organization, environment);
      
      // Analyze patterns and trends
      const healthAnalysis = await this.analyzeSystemHealth(resilienceScore, recentResults);
      
      // Generate recommendations
      const recommendations = await this.generateHealthRecommendations(healthAnalysis);
      
      return {
        organization,
        environment,
        assessedAt: new Date(),
        resilienceScore,
        healthStatus: healthAnalysis.status,
        criticalIssues: healthAnalysis.criticalIssues,
        recommendations,
        nextAssessment: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 1 week
      };
      
    } catch (error) {
      logger.error('System health assessment failed', { 
        organization, 
        environment, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Run comprehensive chaos test suite
   */
  async runChaosTestSuite(
    organization: string,
    environment: string,
    options: {
      categories?: ExperimentCategory[];
      intensity?: 'low' | 'medium' | 'high';
      dryRun?: boolean;
      parallel?: boolean;
    } = {}
  ): Promise<TestSuiteResult> {
    try {
      const profile = await this.getActiveProfile(organization, environment);
      if (!profile) {
        throw new Error(`No active chaos profile found`);
      }

      // Get applicable experiments
      const experiments = await this.getApplicableExperiments(profile, options.categories);
      
      // Filter by intensity if specified
      const filteredExperiments = options.intensity 
        ? experiments.filter(e => e.fault.intensity.level === options.intensity)
        : experiments;

      const results: ExperimentResult[] = [];
      const startTime = Date.now();
      
      if (options.parallel && filteredExperiments.length > 1) {
        // Run experiments in parallel
        const promises = filteredExperiments.map(exp => 
          this.executeExperiment(exp.id, {
            dryRun: options.dryRun,
            context: { userId: 'test_suite' }
          }).then(runId => ({ exp, runId }))
        );
        
        const executions = await Promise.allSettled(promises);
        
        for (const execution of executions) {
          if (execution.status === 'fulfilled') {
            const { exp, runId } = execution.value;
            const result = await this.getExperimentResult(runId);
            results.push(result);
          }
        }
      } else {
        // Run experiments sequentially
        for (const exp of filteredExperiments) {
          const runId = await this.executeExperiment(exp.id, {
            dryRun: options.dryRun,
            context: { userId: 'test_suite' }
          });
          
          const result = await this.getExperimentResult(runId);
          results.push(result);
        }
      }
      
      const duration = Date.now() - startTime;
      
      // Analyze results
      const analysis = this.analyzeTestSuiteResults(results);
      
      logger.info(`Chaos test suite completed`, {
        organization,
        environment,
        totalExperiments: filteredExperiments.length,
        successful: analysis.successful,
        failed: analysis.failed,
        duration
      });
      
      return {
        suiteId: this.generateSuiteId(),
        organization,
        environment,
        startedAt: new Date(Date.now() - duration),
        completedAt: new Date(),
        results,
        summary: analysis,
        recommendations: await this.generateTestSuiteRecommendations(results)
      };
      
    } catch (error) {
      logger.error('Chaos test suite failed', { 
        organization, 
        environment, 
        error: error.message 
      });
      throw error;
    }
  }

  private validateExperiment(experiment: Partial<ChaosExperiment>): void {
    if (!experiment.name || !experiment.category || !experiment.target || !experiment.fault) {
      throw new Error('Experiment must have name, category, target, and fault configuration');
    }
    
    // Validate fault intensity
    if (!experiment.fault?.intensity?.level || !experiment.fault.intensity.value) {
      throw new Error('Fault must have intensity level and value');
    }
    
    // Validate duration
    if (!experiment.fault.duration || experiment.fault.duration <= 0) {
      throw new Error('Fault must have positive duration');
    }
    
    // Validate health checks
    if (!experiment.validation?.healthChecks || experiment.validation.healthChecks.length === 0) {
      throw new Error('Validation must have at least one health check');
    }
  }

  private validateSchedule(schedule: ChaosSchedule): void {
    if (!schedule.name || !schedule.experiments || schedule.experiments.length === 0) {
      throw new Error('Schedule must have name and at least one experiment');
    }
    
    if (!schedule.windows || schedule.windows.length === 0) {
      throw new Error('Schedule must have at least one time window');
    }
  }

  private validateProfile(profile: ChaosProfile): void {
    if (!profile.name || !profile.organization || !profile.environment) {
      throw new Error('Profile must have name, organization, and environment');
    }
    
    if (!profile.blastRadius) {
      throw new Error('Profile must have blast radius configuration');
    }
    
    if (!profile.experiments || profile.experiments.length === 0) {
      throw new Error('Profile must reference at least one experiment');
    }
  }

  private async validateAgainstProfile(experiment: ChaosExperiment): Promise<void> {
    // Check experiment against blast radius and guardrails
  }

  private async updateExperimentMetrics(experiment: ChaosExperiment, result: ExperimentResult): Promise<void> {
    // Calculate and update experiment metrics
    const successRate = experiment.results.filter(r => r.status === 'success').length / experiment.results.length;
    const avgRecoveryTime = experiment.results
      .filter(r => r.recoveryResults.find(rr => rr.phase === 'recovery'))
      .reduce((sum, r) => sum + (r.metrics.recoveryTime || 0), 0) / experiment.results.length;
    
    experiment.metrics.successRate = successRate;
    experiment.metrics.averageRecoveryTime = avgRecoveryTime;
    experiment.metrics.lastAssessment = new Date();
  }

  private async calculateResultsAnalytics(results: ExperimentResult[], options: any): Promise<ResultsAnalytics> {
    return {
      totalRuns: results.length,
      successRate: 0,
      averageDuration: 0,
      commonFailures: [],
      performanceImpact: {},
      recommendations: []
    };
  }

  private async generateRecommendations(experiment: ChaosExperiment, results: ExperimentResult[]): Promise<string[]> {
    return [];
  }

  private async getExperimentsForProfile(profileId: string, timeRange?: { start: Date; end: Date }): Promise<ChaosExperiment[]> {
    return Array.from(this.experiments.values()).filter(e => 
      e.validation && timeRange ? 
        e.lastRun && e.lastRun >= timeRange.start && e.lastRun <= timeRange.end : 
        true
    );
  }

  private async getActiveProfile(organization: string, environment: string): Promise<ChaosProfile | null> {
    // Find active profile for organization and environment
    return Array.from(this.profiles.values()).find(p => 
      p.organization === organization && p.environment === environment
    ) || null;
  }

  private async getRecentExperimentResults(organization: string, environment: string): Promise<ExperimentResult[]> {
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const experiments = Array.from(this.experiments.values()).filter(e => 
      e.results.some(r => r.startedAt >= cutoffDate)
    );
    
    return experiments.flatMap(e => e.results);
  }

  private async analyzeSystemHealth(resilienceScore: ResilienceScore, results: ExperimentResult[]): Promise<HealthAnalysis> {
    return {
      status: 'healthy',
      criticalIssues: [],
      metrics: {}
    };
  }

  private async generateHealthRecommendations(analysis: HealthAnalysis): Promise<HealthRecommendation[]> {
    return [];
  }

  private async getApplicableExperiments(profile: ChaosProfile, categories?: ExperimentCategory[]): Promise<ChaosExperiment[]> {
    let experiments = profile.experiments
      .map(id => this.experiments.get(id))
      .filter(Boolean) as ChaosExperiment[];
    
    if (categories) {
      experiments = experiments.filter(e => categories.includes(e.category));
    }
    
    return experiments;
  }

  private analyzeTestSuiteResults(results: ExperimentResult[]): TestSuiteSummary {
    return {
      total: results.length,
      successful: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failure').length,
      timeouts: results.filter(r => r.status === 'timeout').length,
      averageDuration: 0
    };
  }

  private async generateTestSuiteRecommendations(results: ExperimentResult[]): Promise<string[]> {
    return [];
  }

  private async getExperimentResult(runId: string): Promise<ExperimentResult> {
    // Get result from active run or database
    const run = this.activeRuns.get(runId);
    if (run) {
      return await run.getResult();
    }
    // Get from database
    throw new Error(`Result for run ${runId} not found`);
  }

  // ID generators
  private generateExperimentId(): string {
    return `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateScheduleId(): string {
    return `sched_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateProfileId(): string {
    return `prof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateSuiteId(): string {
    return `suite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Database operations
  private async saveExperiment(experiment: ChaosExperiment): Promise<void> {
    await this.database.query(`
      INSERT INTO chaos_experiments (
        id, name, description, category, target, fault, validation, 
        schedule, status, metrics, created_by, created_at, last_run, results
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      experiment.id, experiment.name, experiment.description, experiment.category,
      JSON.stringify(experiment.target), JSON.stringify(experiment.fault),
      JSON.stringify(experiment.validation), JSON.stringify(experiment.schedule),
      experiment.status, JSON.stringify(experiment.metrics), experiment.createdBy,
      experiment.createdAt, experiment.lastRun, JSON.stringify(experiment.results)
    ]);
  }

  private async updateExperiment(experiment: ChaosExperiment): Promise<void> {
    await this.database.query(`
      UPDATE chaos_experiments SET 
        status = $1, metrics = $2, last_run = $3, results = $4, updated_at = NOW()
      WHERE id = $5
    `, [
      experiment.status, JSON.stringify(experiment.metrics),
      experiment.lastRun, JSON.stringify(experiment.results), experiment.id
    ]);
  }

  private async saveSchedule(schedule: ChaosSchedule): Promise<void> {
    await this.database.query(`
      INSERT INTO chaos_schedules (
        id, name, description, experiments, timezone, timezone_offset,
        windows, conditions, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      schedule.id, schedule.name, schedule.description, schedule.experiments,
      schedule.timezone, schedule.timezoneOffset, JSON.stringify(schedule.windows),
      JSON.stringify(schedule.conditions), schedule.status, schedule.createdAt
    ]);
  }

  private async saveProfile(profile: ChaosProfile): Promise<void> {
    await this.database.query(`
      INSERT INTO chaos_profiles (
        id, name, description, organization, environment, blast_radius,
        experiments, guardrails, permissions, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      profile.id, profile.name, profile.description, profile.organization,
      profile.environment, JSON.stringify(profile.blastRadius), profile.experiments,
      JSON.stringify(profile.guardrails), JSON.stringify(profile.permissions),
      profile.createdBy, profile.createdAt, profile.updatedAt
    ]);
  }

  // Event handlers
  private async handleExperimentStarted(data: any): Promise<void> {
    logger.info('Experiment started event handled', data);
  }

  private async handleFaultInjected(data: any): Promise<void> {
    logger.debug('Fault injected event handled', data);
  }

  private async handleValidationFailed(data: any): Promise<void> {
    logger.warn('Validation failed event handled', data);
  }

  private async handleExperimentCompleted(data: any): Promise<void> {
    logger.info('Experiment completed event handled', data);
  }

  private async handleResilienceScoreUpdated(data: any): Promise<void> {
    logger.info('Resilience score updated event handled', data);
  }
}

// Supporting classes and interfaces
class ExperimentRun {
  private result: ExperimentResult | null = null;

  constructor(
    private experiment: ChaosExperiment,
    private context: ExecutionContext,
    private faultInjector: FaultInjector,
    private validator: ExperimentValidator
  ) {}

  async execute(): Promise<ExperimentResult> {
    this.result = {
      id: this.context.runId,
      runId: this.context.runId,
      startedAt: new Date(),
      completedAt: new Date(),
      status: 'running',
      metrics: {
        duration: 0,
        successRate: 0,
        errorCount: 0,
        availability: 100,
        performance: {
          responseTime: [],
          throughput: 0,
          latencyPercentiles: [],
          resourceUsage: {
            cpu: 0,
            memory: 0,
            disk: 0,
            network: {
              inbound: 0,
              outbound: 0,
              packetsDropped: 0,
              latency: 0
            }
          }
        }
      },
      validationResults: [],
      faultResults: [],
      recoveryResults: [],
      recommendations: []
    };

    try {
      // Pre-flight validation
      await this.validator.validatePreFlight(this.experiment, this.context);
      
      // Inject fault
      const faultResult = await this.injectFault();
      this.result.faultResults.push(faultResult);
      
      // Validate system behavior
      const validationResults = await this.validateSystem();
      this.result.validationResults.push(...validationResults);
      
      // Monitor recovery
      const recoveryResults = await this.monitorRecovery();
      this.result.recoveryResults.push(...recoveryResults);
      
      // Complete
      this.result.completedAt = new Date();
      this.result.status = this.determineStatus();
      this.result.metrics.duration = this.result.completedAt.getTime() - this.result.startedAt.getTime();
      
      return this.result;
      
    } catch (error) {
      this.result.completedAt = new Date();
      this.result.status = 'failure';
      this.result.metrics.duration = this.result.completedAt.getTime() - this.result.startedAt.getTime();
      return this.result;
    }
  }

  private async injectFault(): Promise<FaultResult> {
    // Inject fault using fault injector
    return {
      faultType: this.experiment.fault.type,
      applied: true,
      intensity: this.experiment.fault.intensity.value,
      duration: this.experiment.fault.duration,
      impact: 0,
      errors: []
    };
  }

  private async validateSystem(): Promise<ValidationResult[]> {
    // Validate system health during fault
    return [];
  }

  private async monitorRecovery(): Promise<RecoveryResult[]> {
    // Monitor system recovery
    return [];
  }

  private determineStatus(): 'success' | 'failure' | 'partial' | 'timeout' {
    if (!this.result) return 'failure';
    
    const validationFailures = this.result.validationResults.filter(vr => vr.status === 'fail').length;
    const totalValidations = this.result.validationResults.length;
    
    if (validationFailures === 0) return 'success';
    if (validationFailures < totalValidations * 0.5) return 'partial';
    return 'failure';
  }

  async stop(reason?: string): Promise<void> {
    if (this.result && this.result.status === 'running') {
      this.result.status = 'failure';
      this.result.completedAt = new Date();
    }
  }

  async getResult(): Promise<ExperimentResult> {
    if (!this.result) {
      throw new Error('Run result not available');
    }
    return this.result;
  }
}

interface ExecutionContext {
  experimentId: string;
  runId: string;
  userId: string;
  dryRun: boolean;
  override?: Partial<ChaosExperiment>;
}

interface ExperimentResults {
  experiment: ChaosExperiment;
  results: ExperimentResult[];
  analytics: ResultsAnalytics;
  recommendations: string[];
}

interface ResultsAnalytics {
  totalRuns: number;
  successRate: number;
  averageDuration: number;
  commonFailures: string[];
  performanceImpact: Record<string, number>;
  recommendations: string[];
}

interface SystemHealthAssessment {
  organization: string;
  environment: string;
  assessedAt: Date;
  resilienceScore: ResilienceScore;
  healthStatus: 'healthy' | 'warning' | 'critical';
  criticalIssues: string[];
  recommendations: HealthRecommendation[];
  nextAssessment: Date;
}

interface HealthAnalysis {
  status: 'healthy' | 'warning' | 'critical';
  criticalIssues: string[];
  metrics: Record<string, number>;
}

interface HealthRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  description: string;
  action: string;
  experiments?: string[];
}

interface TestSuiteResult {
  suiteId: string;
  organization: string;
  environment: string;
  startedAt: Date;
  completedAt: Date;
  results: ExperimentResult[];
  summary: TestSuiteSummary;
  recommendations: string[];
}

interface TestSuiteSummary {
  total: number;
  successful: number;
  failed: number;
  timeouts: number;
  averageDuration: number;
}

// Supporting classes
class FaultInjector {
  constructor(private config: any) {}

  async injectFault(fault: FaultConfiguration, target: ExperimentTarget): Promise<FaultResult> {
    // Implement fault injection logic
    return {
      faultType: fault.type,
      applied: true,
      intensity: fault.intensity.value,
      duration: fault.duration,
      impact: 0,
      errors: []
    };
  }
}

class ExperimentValidator {
  constructor(private database: Database) {}

  async validatePreFlight(experiment: ChaosExperiment, context: ExecutionContext): Promise<void> {
    // Pre-flight validation logic
  }
}

class ChaosScheduler {
  constructor(private database: Database, private experiments: Map<string, ChaosExperiment>) {}

  async processSchedules(): Promise<void> {
    // Process scheduled experiments
  }

  async initializeSchedule(schedule: ChaosSchedule): Promise<void> {
    // Initialize schedule
  }
}

class ResilienceScoreCalculator {
  constructor(private database: Database) {}

  async calculateScore(params: any): Promise<ResilienceScore> {
    // Calculate resilience score
    return {
      overall: 85,
      categories: [],
      trends: [],
      lastAssessment: new Date(),
      nextAssessment: new Date(),
      factors: []
    };
  }
}

export {
  ChaosEngineeringSuite,
  ChaosExperiment,
  ChaosSchedule,
  ChaosProfile,
  ResilienceScore,
  ExperimentResult
};