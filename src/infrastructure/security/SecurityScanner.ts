import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Redis } from '@upstash/redis';

export interface SecurityScannerConfig {
  redis: Redis;
  scanSchedule: {
    dependency: string; // cron schedule
    code: string; // cron schedule
    container: string; // cron schedule
  };
  reportRetention: number; // days
  webhookUrl?: string;
  severityThresholds: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  enableNotifications: boolean;
}

export interface SecurityFinding {
  id: string;
  type: 'vulnerability' | 'misconfiguration' | 'secret' | 'license' | 'compliance';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  description: string;
  file?: string;
  line?: number;
  codeSnippet?: string;
  cveId?: string;
  cvssScore?: number;
  packageName?: string;
  packageVersion?: string;
  fixedVersion?: string;
  recommendations: string[];
  references: string[];
  firstSeen: Date;
  lastSeen: Date;
  status: 'open' | 'false_positive' | 'resolved' | 'accepted';
  assignee?: string;
  tags: string[];
}

export interface SecurityReport {
  id: string;
  type: 'dependency' | 'code' | 'container' | 'infrastructure';
  timestamp: Date;
  duration: number; // milliseconds
  summary: {
    totalFindings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  findings: SecurityFinding[];
  metrics: {
    linesOfCode?: number;
    dependenciesScanned?: number;
    packagesScanned?: number;
    containersScanned?: number;
  };
  metadata: {
    branch?: string;
    commit?: string;
    buildId?: string;
    environment: string;
  };
}

export interface SecurityConfig {
  dependencies: {
    enabled: boolean;
    tools: string[];
    excludePackages?: string[];
    includeDevDependencies: boolean;
  };
  code: {
    enabled: boolean;
    tools: string[];
    rules: string[];
    excludePatterns?: string[];
  };
  secrets: {
    enabled: boolean;
    patterns: string[];
    excludePaths?: string[];
  };
  infrastructure: {
    enabled: boolean;
    cloudProvider?: 'aws' | 'azure' | 'gcp';
    resources: string[];
  };
}

export class SecurityScanner {
  private redis: Redis;
  private config: SecurityScannerConfig;
  private scanResults: Map<string, SecurityReport> = new Map();

  constructor(config: SecurityScannerConfig) {
    this.redis = config.redis;
    this.config = config;
  }

  /**
   * Run comprehensive security scan
   */
  async runFullScan(): Promise<SecurityReport[]> {
    console.log('Starting comprehensive security scan...');
    const startTime = Date.now();
    const reports: SecurityReport[] = [];

    try {
      // 1. Dependency vulnerability scan
      const dependencyReport = await this.scanDependencies();
      if (dependencyReport) {
        reports.push(dependencyReport);
        await this.saveReport(dependencyReport);
      }

      // 2. Static code analysis
      const codeReport = await this.scanCode();
      if (codeReport) {
        reports.push(codeReport);
        await this.saveReport(codeReport);
      }

      // 3. Secret detection
      const secretReport = await this.scanSecrets();
      if (secretReport) {
        reports.push(secretReport);
        await this.saveReport(secretReport);
      }

      // 4. Infrastructure security scan
      const infraReport = await this.scanInfrastructure();
      if (infraReport) {
        reports.push(infraReport);
        await this.saveReport(infraReport);
      }

      const duration = Date.now() - startTime;
      console.log(`Security scan completed in ${duration}ms`);

      // 5. Send notifications if findings exceed thresholds
      await this.checkThresholdsAndNotify(reports);

      return reports;

    } catch (error) {
      console.error('Security scan failed:', error);
      throw error;
    }
  }

  /**
   * Scan dependencies for vulnerabilities
   */
  async scanDependencies(): Promise<SecurityReport | null> {
    try {
      const startTime = Date.now();
      console.log('Scanning dependencies for vulnerabilities...');

      const findings: SecurityFinding[] = [];

      // Run npm audit
      const npmAuditResults = await this.runCommand('npm', ['audit', '--json']);
      if (npmAuditResults.stdout) {
        const auditData = JSON.parse(npmAuditResults.stdout);
        const vulnerabilities = this.parseNpmAuditResults(auditData);
        findings.push(...vulnerabilities);
      }

      // Run Snyk scan if available
      const snykResults = await this.runSnykScan();
      if (snykResults) {
        findings.push(...snykResults);
      }

      // Run OWASP Dependency-Check
      const dependencyCheckResults = await this.runDependencyCheck();
      if (dependencyCheckResults) {
        findings.push(...dependencyCheckResults);
      }

      const duration = Date.now() - startTime;

      const report: SecurityReport = {
        id: this.generateReportId('dependency'),
        type: 'dependency',
        timestamp: new Date(),
        duration,
        summary: this.calculateSummary(findings),
        findings,
        metrics: {
          dependenciesScanned: findings.length
        },
        metadata: {
          environment: process.env.NODE_ENV || 'development'
        }
      };

      return report;

    } catch (error) {
      console.error('Dependency scan failed:', error);
      return null;
    }
  }

  /**
   * Perform static code analysis
   */
  async scanCode(): Promise<SecurityReport | null> {
    try {
      const startTime = Date.now();
      console.log('Performing static code analysis...');

      const findings: SecurityFinding[] = [];

      // Run ESLint with security rules
      const eslintResults = await this.runESLint();
      if (eslintResults) {
        findings.push(...eslintResults);
      }

      // Run Semgrep for advanced security analysis
      const semgrepResults = await this.runSemgrep();
      if (semgrepResults) {
        findings.push(...semgrepResults);
      }

      // Run CodeQL analysis if available
      const codeQLResults = await this.runCodeQL();
      if (codeQLResults) {
        findings.push(...codeQLResults);
      }

      const duration = Date.now() - startTime;

      const report: SecurityReport = {
        id: this.generateReportId('code'),
        type: 'code',
        timestamp: new Date(),
        duration,
        summary: this.calculateSummary(findings),
        findings,
        metrics: {
          linesOfCode: await this.countLinesOfCode()
        },
        metadata: {
          branch: process.env.GIT_BRANCH,
          commit: process.env.GIT_COMMIT,
          environment: process.env.NODE_ENV || 'development'
        }
      };

      return report;

    } catch (error) {
      console.error('Code scan failed:', error);
      return null;
    }
  }

  /**
   * Scan for exposed secrets
   */
  async scanSecrets(): Promise<SecurityReport | null> {
    try {
      const startTime = Date.now();
      console.log('Scanning for exposed secrets...');

      const findings: SecurityFinding[] = [];
      const secretPatterns = this.getSecretPatterns();

      // Scan files for secret patterns
      const files = await this.findFilesToScan();
      
      for (const file of files) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const fileFindings = this.scanContentForSecrets(content, file, secretPatterns);
          findings.push(...fileFindings);
        } catch (error) {
          console.warn(`Could not read file ${file}:`, error);
        }
      }

      // Run GitLeaks if available
      const gitLeaksResults = await this.runGitLeaks();
      if (gitLeaksResults) {
        findings.push(...gitLeaksResults);
      }

      const duration = Date.now() - startTime;

      const report: SecurityReport = {
        id: this.generateReportId('secret'),
        type: 'code',
        timestamp: new Date(),
        duration,
        summary: this.calculateSummary(findings),
        findings,
        metadata: {
          environment: process.env.NODE_ENV || 'development'
        }
      };

      return report;

    } catch (error) {
      console.error('Secret scan failed:', error);
      return null;
    }
  }

  /**
   * Scan infrastructure for security issues
   */
  async scanInfrastructure(): Promise<SecurityReport | null> {
    try {
      const startTime = Date.now();
      console.log('Scanning infrastructure security...');

      const findings: SecurityFinding[] = [];

      // Scan Docker images if Dockerfile exists
      if (await this.fileExists('Dockerfile')) {
        const dockerFindings = await this.scanDockerImage();
        findings.push(...dockerFindings);
      }

      // Scan Terraform files if they exist
      const terraformFiles = await this.findFiles('*.tf');
      if (terraformFiles.length > 0) {
        const tfFindings = await this.scanTerraformFiles(terraformFiles);
        findings.push(...tfFindings);
      }

      // Run cloud security scanner
      const cloudFindings = await this.scanCloudSecurity();
      if (cloudFindings) {
        findings.push(...cloudFindings);
      }

      const duration = Date.now() - startTime;

      const report: SecurityReport = {
        id: this.generateReportId('infrastructure'),
        type: 'infrastructure',
        timestamp: new Date(),
        duration,
        summary: this.calculateSummary(findings),
        findings,
        metadata: {
          environment: process.env.NODE_ENV || 'development'
        }
      };

      return report;

    } catch (error) {
      console.error('Infrastructure scan failed:', error);
      return null;
    }
  }

  // Individual scanner methods

  private async runSnykScan(): Promise<SecurityFinding[] | null> {
    try {
      const result = await this.runCommand('snyk', ['test', '--json']);
      if (result.stdout) {
        const snykData = JSON.parse(result.stdout);
        return this.parseSnykResults(snykData);
      }
    } catch (error) {
      console.warn('Snyk scan not available or failed:', error);
    }
    return null;
  }

  private async runDependencyCheck(): Promise<SecurityFinding[] | null> {
    try {
      const result = await this.runCommand('dependency-check', ['--project', 'Vow', '--scan', '.', '--format', 'JSON']);
      if (result.stdout) {
        const dcData = JSON.parse(result.stdout);
        return this.parseDependencyCheckResults(dcData);
      }
    } catch (error) {
      console.warn('OWASP Dependency-Check not available:', error);
    }
    return null;
  }

  private async runESLint(): Promise<SecurityFinding[] | null> {
    try {
      const result = await this.runCommand('npx', ['eslint', '.', '--format', 'json']);
      if (result.stdout) {
        const eslintData = JSON.parse(result.stdout);
        return this.parseESLintResults(eslintData);
      }
    } catch (error) {
      console.warn('ESLint not available or failed:', error);
    }
    return null;
  }

  private async runSemgrep(): Promise<SecurityFinding[] | null> {
    try {
      const result = await this.runCommand('semgrep', ['--config=auto', '--json', '.']);
      if (result.stdout) {
        const semgrepData = JSON.parse(result.stdout);
        return this.parseSemgrepResults(semgrepData);
      }
    } catch (error) {
      console.warn('Semgrep not available:', error);
    }
    return null;
  }

  private async runCodeQL(): Promise<SecurityFinding[] | null> {
    try {
      // CodeQL would typically be run in CI/CD pipeline
      // Placeholder implementation
      return null;
    } catch (error) {
      console.warn('CodeQL not available:', error);
    }
    return null;
  }

  private async runGitLeaks(): Promise<SecurityFinding[] | null> {
    try {
      const result = await this.runCommand('gitleaks', ['detect', '--source', '.', '--report-format', 'json']);
      if (result.stdout) {
        const gitLeaksData = JSON.parse(result.stdout);
        return this.parseGitLeaksResults(gitLeaksData);
      }
    } catch (error) {
      console.warn('GitLeaks not available:', error);
    }
    return null;
  }

  private async scanDockerImage(): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];

    try {
      // Run Trivy for container scanning
      const trivyResult = await this.runCommand('trivy', ['fs', '--format', 'json', '.']);
      if (trivyResult.stdout) {
        const trivyData = JSON.parse(trivyResult.stdout);
        const trivyFindings = this.parseTrivyResults(trivyData);
        findings.push(...trivyFindings);
      }
    } catch (error) {
      console.warn('Trivy not available:', error);
    }

    return findings;
  }

  private async scanTerraformFiles(files: string[]): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];

    // Run tfsec for Terraform security scanning
    try {
      const tfsecResult = await this.runCommand('tfsec', ['--format', 'json', ...files]);
      if (tfsecResult.stdout) {
        const tfsecData = JSON.parse(tfsecResult.stdout);
        const tfsecFindings = this.parseTfsecResults(tfsecData);
        findings.push(...tfsecFindings);
      }
    } catch (error) {
      console.warn('tfsec not available:', error);
    }

    return findings;
  }

  private async scanCloudSecurity(): Promise<SecurityFinding[] | null> {
    try {
      // This would scan cloud resources for misconfigurations
      // Implementation would depend on cloud provider
      return null;
    } catch (error) {
      console.warn('Cloud security scan failed:', error);
      return null;
    }
  }

  // Parsing methods

  private parseNpmAuditResults(auditData: any): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    if (auditData.vulnerabilities) {
      Object.entries(auditData.vulnerabilities).forEach(([pkgName, vuln]: [string, any]) => {
        const finding: SecurityFinding = {
          id: this.generateFindingId(),
          type: 'vulnerability',
          severity: this.mapNpmSeverity(vuln.severity),
          title: `${pkgName} vulnerability`,
          description: vuln.title || `Vulnerability in package ${pkgName}`,
          packageName: pkgName,
          packageVersion: vuln.via?.[0]?.range || 'unknown',
          fixedVersion: vuln.fixAvailable?.name || undefined,
          cveId: vuln.via?.[0]?.cve || undefined,
          cvssScore: vuln.via?.[0]?.cvss_score || undefined,
          recommendations: [vuln.title || 'Update package to latest version'],
          references: vuln.via?.map((v: any) => v.url).filter(Boolean) || [],
          firstSeen: new Date(),
          lastSeen: new Date(),
          status: 'open',
          tags: ['npm', 'dependency']
        };
        findings.push(finding);
      });
    }

    return findings;
  }

  private parseSnykResults(snykData: any): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    if (snykData.vulnerabilities) {
      snykData.vulnerabilities.forEach((vuln: any) => {
        const finding: SecurityFinding = {
          id: this.generateFindingId(),
          type: 'vulnerability',
          severity: this.mapSnykSeverity(vuln.severity),
          title: vuln.title || 'Security vulnerability',
          description: vuln.description || '',
          packageName: vuln.packageName,
          packageVersion: vuln.version,
          fixedVersion: vuln.fixVersion,
          cveId: vuln.identifiers?.CVE?.[0],
          cvssScore: vuln.cvssScore,
          recommendations: [vuln.fixUpgrade || 'Update to latest version'],
          references: vuln.urls || [],
          firstSeen: new Date(vuln.firstSeen),
          lastSeen: new Date(),
          status: 'open',
          tags: ['snyk', 'vulnerability']
        };
        findings.push(finding);
      });
    }

    return findings;
  }

  private parseESLintResults(eslintData: any[]): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    eslintData.forEach(file => {
      file.messages?.forEach((message: any) => {
        if (this.isSecurityRule(message.ruleId)) {
          const finding: SecurityFinding = {
            id: this.generateFindingId(),
            type: 'misconfiguration',
            severity: this.mapESLintSeverity(message.severity),
            title: message.message,
            description: `${message.ruleId}: ${message.message}`,
            file: file.filePath,
            line: message.line,
            recommendations: [this.getESLintRecommendation(message.ruleId)],
            references: [],
            firstSeen: new Date(),
            lastSeen: new Date(),
            status: 'open',
            tags: ['eslint', 'static-analysis']
          };
          findings.push(finding);
        }
      });
    });

    return findings;
  }

  private parseSemgrepResults(semgrepData: any): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    if (semgrepData.results) {
      semgrepData.results.forEach((result: any) => {
        const finding: SecurityFinding = {
          id: this.generateFindingId(),
          type: 'misconfiguration',
          severity: this.mapSemgrepSeverity(result.extra?.severity),
          title: result.check_id,
          description: result.extra?.message || '',
          file: result.path,
          line: result.start?.line,
          codeSnippet: result.extra?.lines,
          recommendations: [result.extra?.fix || 'Review and fix the identified issue'],
          references: result.extra?.metadata?.references || [],
          firstSeen: new Date(),
          lastSeen: new Date(),
          status: 'open',
          tags: ['semgrep', result.check_id]
        };
        findings.push(finding);
      });
    }

    return findings;
  }

  private parseGitLeaksResults(gitLeaksData: any): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    gitLeaksData.forEach((secret: any) => {
      const finding: SecurityFinding = {
        id: this.generateFindingId(),
        type: 'secret',
        severity: 'high',
        title: `Exposed ${secret.RuleID}`,
        description: `Potential secret detected: ${secret.RuleID}`,
        file: secret.File,
        line: secret.StartLine,
        codeSnippet: secret.Match,
        recommendations: ['Remove the exposed secret from the codebase', 'Rotate the secret if it has been compromised'],
        references: [],
        firstSeen: new Date(),
        lastSeen: new Date(),
        status: 'open',
        tags: ['secret', 'git-secrets']
      };
      findings.push(finding);
    });

    return findings;
  }

  // Helper methods

  private async runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, { stdio: 'pipe' });
      
      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr, code: code || 0 });
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }

  private generateReportId(type: string): string {
    return `scan_${type}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  private generateFindingId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private calculateSummary(findings: SecurityFinding[]): SecurityReport['summary'] {
    const summary = {
      totalFindings: findings.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };

    findings.forEach(finding => {
      summary[finding.severity as keyof typeof summary]++;
    });

    return summary;
  }

  private async saveReport(report: SecurityReport): Promise<void> {
    const cacheKey = `security:report:${report.id}`;
    await this.redis.setex(cacheKey, this.config.reportRetention * 86400, JSON.stringify(report));
    
    // Also update latest reports list
    await this.redis.lpush('security:reports:latest', report.id);
    await this.redis.ltrim('security:reports:latest', 0, 99); // Keep last 100 reports
  }

  private async checkThresholdsAndNotify(reports: SecurityReport[]): Promise<void> {
    if (!this.config.enableNotifications) return;

    const totalCritical = reports.reduce((sum, r) => sum + r.summary.critical, 0);
    const totalHigh = reports.reduce((sum, r) => sum + r.summary.high, 0);

    if (totalCritical >= this.config.severityThresholds.critical ||
        totalHigh >= this.config.severityThresholds.high) {
      await this.sendSecurityAlert(reports);
    }
  }

  private async sendSecurityAlert(reports: SecurityReport[]): Promise<void> {
    if (this.config.webhookUrl) {
      // Send alert to webhook (Slack, Teams, etc.)
      console.log('Security alert triggered - check dashboard');
    }
  }

  // Additional helper methods for parsing and scanning...

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async findFiles(pattern: string): Promise<string[]> {
    // Implementation would use glob or similar
    return [];
  }

  private async countLinesOfCode(): Promise<number> {
    // Implementation would count lines in source files
    return 0;
  }

  private getSecretPatterns(): Array<{ name: string; pattern: RegExp; description: string }> {
    return [
      {
        name: 'AWS Access Key',
        pattern: /AKIA[0-9A-Z]{16}/g,
        description: 'AWS Access Key ID'
      },
      {
        name: 'AWS Secret Key',
        pattern: /[0-9a-zA-Z/+]{40}/g,
        description: 'AWS Secret Access Key'
      },
      {
        name: 'GitHub Token',
        pattern: /ghp_[0-9a-zA-Z]{36}/g,
        description: 'GitHub Personal Access Token'
      },
      {
        name: 'Private Key',
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
        description: 'Private Key'
      }
    ];
  }

  private scanContentForSecrets(content: string, file: string, patterns: any[]): SecurityFinding[] {
    const findings: SecurityFinding[] = [];

    patterns.forEach(({ name, pattern, description }) => {
      const matches = content.match(pattern);
      if (matches) {
        findings.push({
          id: this.generateFindingId(),
          type: 'secret',
          severity: 'high',
          title: `Exposed ${name}`,
          description: description,
          file,
          recommendations: ['Remove the secret from the file', 'Use environment variables instead'],
          references: [],
          firstSeen: new Date(),
          lastSeen: new Date(),
          status: 'open',
          tags: ['secret-detection']
        });
      }
    });

    return findings;
  }

  // Mapping methods for different tool severities
  private mapNpmSeverity(severity: string): SecurityFinding['severity'] {
    switch (severity.toLowerCase()) {
      case 'critical': return 'critical';
      case 'high': return 'high';
      case 'moderate': return 'medium';
      case 'low': return 'low';
      default: return 'info';
    }
  }

  private mapSnykSeverity(severity: string): SecurityFinding['severity'] {
    return this.mapNpmSeverity(severity);
  }

  private mapESLintSeverity(severity: number): SecurityFinding['severity'] {
    if (severity === 2) return 'high';
    if (severity === 1) return 'medium';
    return 'low';
  }

  private mapSemgrepSeverity(severity: string): SecurityFinding['severity'] {
    switch (severity?.toLowerCase()) {
      case 'error': return 'high';
      case 'warning': return 'medium';
      default: return 'low';
    }
  }

  private isSecurityRule(ruleId: string): boolean {
    return ruleId?.includes('security') || ruleId?.includes('no-eval') || ruleId?.includes('no-implied-eval');
  }

  private getESLintRecommendation(ruleId: string): string {
    const recommendations: Record<string, string> = {
      'no-eval': 'Avoid using eval() for security reasons',
      'no-implied-eval': 'Avoid using setTimeout with string arguments',
      'security/detect-object-injection': 'Avoid object injection vulnerabilities'
    };
    return recommendations[ruleId] || 'Review security implications';
  }

  // Placeholder implementations for remaining parsers
  private parseDependencyCheckResults(data: any): SecurityFinding[] { return []; }
  private parseTrivyResults(data: any): SecurityFinding[] { return []; }
  private parseTfsecResults(data: any): SecurityFinding[] { return []; }
  private async findFilesToScan(): Promise<string[]> { return []; }
}

// Factory function
export function createSecurityScanner(redis: Redis): SecurityScanner {
  return new SecurityScanner({
    redis,
    scanSchedule: {
      dependency: '0 6 * * *', // Daily at 6 AM
      code: '0 2 * * 1', // Weekly on Monday at 2 AM
      container: '0 4 * * *' // Daily at 4 AM
    },
    reportRetention: 90,
    severityThresholds: {
      critical: 1,
      high: 5,
      medium: 20,
      low: 50
    },
    enableNotifications: true
  });
}

// Export types
export type {
  SecurityScannerConfig,
  SecurityFinding,
  SecurityReport,
  SecurityConfig
};