/**
 * Complete error type system for Vow application
 * Extends ReadFlexError with domain-specific error types
 */

import { z } from 'zod';

/**
 * Base error class for all Vow application errors
 */
export abstract class ReadFlexError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  abstract readonly shouldReport: boolean;

  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = this.constructor.name;
    
    // Capture stack trace for better debugging
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to a serializable format for API responses
   */
  toJSON(): {
    code: string;
    message: string;
    statusCode: number;
    timestamp: string;
    path?: string;
  } {
    return {
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Rate limiting error - user has exceeded API limits
 */
export class RateLimitError extends ReadFlexError {
  readonly code = 'RATE_LIMIT';
  readonly statusCode = 429;
  readonly shouldReport = false;

  constructor(
    message: string = 'Too many requests. Please try again later.',
    public readonly retryAfter?: number,
    public readonly limit?: number
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      retryAfter: this.retryAfter,
      limit: this.limit
    };
  }
}

/**
 * Resource not found error
 */
export class NotFoundError extends ReadFlexError {
  readonly code = 'NOT_FOUND';
  readonly statusCode = 404;
  readonly shouldReport = false;

  constructor(
    message: string = 'Resource not found',
    public readonly entity?: string,
    public readonly entityId?: string
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      entity: this.entity,
      entityId: this.entityId
    };
  }
}

/**
 * Input validation error
 */
export class ValidationError extends ReadFlexError {
  readonly code = 'VALIDATION_ERROR';
  readonly statusCode = 400;
  readonly shouldReport = false;

  constructor(
    message: string = 'Invalid input data',
    public readonly field?: string,
    public readonly value?: any,
    public readonly constraint?: string
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      field: this.field,
      value: this.value,
      constraint: this.constraint
    };
  }
}

/**
 * Authorization error - user lacks permission
 */
export class AuthorizationError extends ReadFlexError {
  readonly code = 'UNAUTHORIZED';
  readonly statusCode = 403;
  readonly shouldReport = false;

  constructor(
    message: string = 'Insufficient permissions',
    public readonly action?: string,
    public readonly resource?: string
  ) {
    super(message);
  }
}

/**
 * Authentication error - user not authenticated
 */
export class AuthenticationError extends ReadFlexError {
  readonly code = 'AUTHENTICATION_REQUIRED';
  readonly statusCode = 401;
  readonly shouldReport = false;

  constructor(
    message: string = 'Authentication required',
    public readonly provider?: string
  ) {
    super(message);
  }
}

/**
 * Resource conflict error - resource already exists
 */
export class ConflictError extends ReadFlexError {
  readonly code = 'CONFLICT';
  readonly statusCode = 409;
  readonly shouldReport = false;

  constructor(
    message: string = 'Resource conflict',
    public readonly field?: string,
    public readonly value?: any,
    public readonly existingResource?: string
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      field: this.field,
      value: this.value,
      existingResource: this.existingResource
    };
  }
}

/**
 * External provider API error
 */
export class ProviderAPIError extends ReadFlexError {
  readonly code = 'PROVIDER_ERROR';
  readonly statusCode = 502;
  readonly shouldReport = true;

  constructor(
    public readonly provider: string,
    message?: string,
    public readonly originalError?: Error,
    public readonly retryable: boolean = false
  ) {
    super(message || `${provider} is currently unavailable`);
  }
}

/**
 * One-time password expired error
 */
export class OTPExpiredError extends ReadFlexError {
  readonly code = 'OTP_EXPIRED';
  readonly statusCode = 410;
  readonly shouldReport = false;

  constructor(message: string = 'Verification code has expired') {
    super(message);
  }
}

/**
 * Image too large error
 */
export class ImageTooLargeError extends ReadFlexError {
  readonly code = 'IMAGE_TOO_LARGE';
  readonly statusCode = 413;
  readonly shouldReport = false;

  constructor(
    message: string = 'Image file size exceeds limit',
    public readonly maxSize: number = 10 * 1024 * 1024, // 10MB
    public readonly actualSize?: number
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      maxSize: this.maxSize,
      actualSize: this.actualSize
    };
  }
}

/**
 * Business rule violation error
 */
export class BusinessRuleError extends ReadFlexError {
  readonly code = 'BUSINESS_RULE_VIOLATION';
  readonly statusCode = 422;
  readonly shouldReport = false;

  constructor(
    message: string,
    public readonly rule?: string,
    public readonly context?: Record<string, any>
  ) {
    super(message);
  }

  toJSON(): ReturnType<ReadFlexError['toJSON']> {
    return {
      ...super.toJSON(),
      rule: this.rule,
      context: this.context
    };
  }
}

/**
 * Database error
 */
export class DatabaseError extends ReadFlexError {
  readonly code = 'DATABASE_ERROR';
  readonly statusCode = 500;
  readonly shouldReport = true;

  constructor(
    message: string = 'Database operation failed',
    public readonly operation?: string,
    public readonly originalError?: Error
  ) {
    super(message);
  }
}

/**
 * Cache error
 */
export class CacheError extends ReadFlexError {
  readonly code = 'CACHE_ERROR';
  readonly statusCode = 503;
  readonly shouldReport = true;

  constructor(
    message: string = 'Cache operation failed',
    public readonly operation?: string,
    public readonly key?: string
  ) {
    super(message);
  }
}

/**
 * Email already registered error
 */
export class EmailAlreadyRegisteredError extends ConflictError {
  constructor(email: string) {
    super(`Email ${email} is already registered`, 'email', email, 'user');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Username already taken error
 */
export class UsernameTakenError extends ConflictError {
  constructor(username: string) {
    super(`Username ${username} is already taken`, 'username', username, 'user');
    this.name = 'UsernameTakenError';
  }
}

/**
 * Phone number already registered error
 */
export class PhoneAlreadyRegisteredError extends ConflictError {
  constructor(phone: string) {
    super(`Phone number ${phone} is already registered`, 'phone', phone, 'user');
    this.name = 'PhoneAlreadyRegisteredError';
  }
}

/**
 * Factory functions for common error scenarios
 */
export const createNotFoundError = (entity: string, id: string): NotFoundError => {
  return new NotFoundError(`${entity} with id '${id}' not found`, entity, id);
};

export const createValidationError = (message: string, field?: string, value?: any): ValidationError => {
  return new ValidationError(message, field, value);
};

export const createConflictError = (message: string, field?: string, value?: any): ConflictError => {
  return new ConflictError(message, field, value);
};

export const createAuthorizationError = (action: string, resource?: string): AuthorizationError => {
  return new AuthorizationError(`Not authorized to ${action}${resource ? ` ${resource}` : ''}`, action, resource);
};

/**
 * Transform Zod validation errors into ValidationError
 */
export function zodToValidationError(error: z.ZodError): ValidationError {
  const firstIssue = error.issues[0];
  return new ValidationError(
    firstIssue.message,
    firstIssue.path.join('.'),
    firstIssue.input,
    firstIssue.code
  );
}

/**
 * Error serialization for API responses
 */
export function serializeError(error: unknown): ReturnType<ReadFlexError['toJSON']> {
  if (error instanceof ReadFlexError) {
    return error.toJSON();
  }

  if (error instanceof Error) {
    return {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' 
        ? 'An unexpected error occurred' 
        : error.message,
      statusCode: 500,
      timestamp: new Date().toISOString()
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unknown error occurred',
    statusCode: 500,
    timestamp: new Date().toISOString()
  };
}

/**
 * Check if an error should be reported to monitoring
 */
export function shouldReportError(error: unknown): boolean {
  if (error instanceof ReadFlexError) {
    return error.shouldReport;
  }
  return true; // Report unknown errors
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyMessage(error: unknown): string {
  if (error instanceof ReadFlexError) {
    switch (error.code) {
      case 'RATE_LIMIT':
        return 'Too many requests. Please wait a moment before trying again.';
      case 'NOT_FOUND':
        return 'The requested resource was not found.';
      case 'VALIDATION_ERROR':
        return 'Please check your input and try again.';
      case 'UNAUTHORIZED':
      case 'AUTHENTICATION_REQUIRED':
        return 'Please sign in to continue.';
      case 'CONFLICT':
        return 'This resource already exists.';
      case 'PROVIDER_ERROR':
        return 'External service is temporarily unavailable.';
      case 'OTP_EXPIRED':
        return 'Verification code has expired. Please request a new one.';
      case 'IMAGE_TOO_LARGE':
        return 'File size is too large. Please choose a smaller image.';
      default:
        return error.message;
    }
  }

  if (error instanceof Error) {
    return 'An unexpected error occurred. Please try again.';
  }

  return 'Something went wrong. Please try again.';
}
