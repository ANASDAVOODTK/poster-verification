import { OpenAI } from "openai";
import { VALIDATION_PROMPT } from "./validationPrompt.js";

const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: process.env.DASHSCOPE_BASE_URL,
});


/**
 * Optimized validation service with CoT and strict schema
 */
export class ValidationService {

  /**
   * Main validation method
   */
  async validatePoster(imageBuffer) {
    try {
      // Single-stage AI analysis with CoT
      const aiResult = await this.performAIAnalysis(imageBuffer);

      // Post-process and validate schema
      const validatedResult = this.validateAndEnrichResult(aiResult);

      return validatedResult;

    } catch (error) {
      console.error('Validation error:', error);

      return {
        isCompliant: false,
        overallScore: 0,
        summary: "Validation failed due to technical error",
        rejectionReason: `Technical error: ${error.message}`,
        error: error.message,
        _analysis_trace: {
          step1_content_extraction: "Error occurred",
          step2_document_type: "Could not analyze",
          step3_violations_found: [],
          step4_decision_logic: "System error"
        }
      };
    }
  }

  /**
   * Perform AI analysis with optimized prompt structure
   */
  async performAIAnalysis(imageBuffer) {
    const base64Image = imageBuffer.toString("base64");

    const response = await openai.chat.completions.create({
      model: "qwen3-vl-plus",
      messages: [
        {
          // System role contains all instructions
          role: "system",
          content: VALIDATION_PROMPT
        },
        {
          // User role is simple and direct
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this election poster for compliance. Return the complete JSON object with _analysis_trace showing your reasoning.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,  // Lower for stricter adherence
      max_tokens: 4096,
      top_p: 0.95,       // Slightly reduce randomness
    });

    const result = JSON.parse(response.choices[0].message.content);

    // Log trace for debugging
    if (result._analysis_trace) {
      console.log('AI Analysis Trace:', JSON.stringify(result._analysis_trace, null, 2));
    }

    return result;
  }

  /**
   * Validate result schema and enrich with computed fields
   */
  validateAndEnrichResult(result) {
    // 1. Validate JSON completeness (catch STOP logic failures)
    const validationErrors = this.validateSchema(result);
    if (validationErrors.length > 0) {
      console.error('Schema validation errors:', validationErrors);
      result.schemaValidation = {
        valid: false,
        errors: validationErrors
      };
    }

    // 2. Fix logic error: non-election material should be non-compliant
    this.fixNonElectionLogic(result);

    // 3. Ensure required fields exist
    if (!result._analysis_trace) {
      console.warn('Missing _analysis_trace - model did not show reasoning');
      result._analysis_trace = {
        step1_content_extraction: "Not provided",
        step2_document_type: "Not provided",
        step3_violations_found: [],
        step4_decision_logic: "Not provided"
      };
    }

    // 4. Validate number detection logic (catch false positives)
    this.validateNumberDetection(result);

    // 5. Deterministic Text Validation (Safety Net)
    this.validateTextContent(result);

    // 5. Compute validation confidence based on trace quality
    result.validationConfidence = this.calculateConfidence(result);

    // 6. Ensure rejection reason is present if non-compliant
    if (!result.isCompliant && !result.rejectionReason) {
      result.rejectionReason = this.generateRejectionReason(result);
    }

    // 7. Add metadata
    result.metadata = {
      timestamp: new Date().toISOString(),
      modelUsed: "qwen3-vl-plus",
      hasAnalysisTrace: !!result._analysis_trace.step1_content_extraction,
      schemaValid: validationErrors.length === 0
    };

    return result;
  }

  /**
   * Fix logic error: non-election material MUST be non-compliant
   */
  fixNonElectionLogic(result) {
    if (result.documentType?.isElectionPropaganda === false) {
      // Non-election material should ALWAYS be non-compliant
      if (result.isCompliant === true) {
        console.warn('Logic error detected: Non-election material marked as compliant. Fixing...');

        result.isCompliant = false;
        result.overallScore = 0;

        // Update decision logic in trace
        if (result._analysis_trace) {
          result._analysis_trace.step4_decision_logic =
            `Non-compliant because this is not election propaganda (${result.documentType.actualType}). ` +
            `It cannot be validated as an election poster.`;
        }

        // Ensure rejection reason exists
        if (!result.rejectionReason) {
          result.rejectionReason = this.generateRejectionReason(result);
        }

        // Add correction metadata
        result.metadata = result.metadata || {};
        result.metadata.logicCorrectionApplied = true;
        result.metadata.correctionReason = 'Non-election material incorrectly marked as compliant';
      }
    }
  }

  /**
   * Validate JSON schema completeness (Fix #1: STOP logic)
   */
  validateSchema(result) {
    const errors = [];

    // Required top-level fields
    if (typeof result.isCompliant !== 'boolean') errors.push('Missing isCompliant');
    if (typeof result.overallScore !== 'number') errors.push('Missing overallScore');
    if (!result.summary) errors.push('Missing summary');

    // documentType validation
    if (!result.documentType) {
      errors.push('Missing documentType');
    } else {
      if (typeof result.documentType.isElectionPropaganda !== 'boolean') {
        errors.push('Missing documentType.isElectionPropaganda');
      }
      if (!result.documentType.actualType) errors.push('Missing documentType.actualType');
    }

    // categories validation (must exist even if empty)
    if (!result.categories) {
      errors.push('Missing categories');
    } else {
      if (!result.categories.prohibitedContent) errors.push('Missing prohibitedContent');
      if (!result.categories.requiredContent) errors.push('Missing requiredContent');
      if (!result.categories.contentScope) errors.push('Missing contentScope');
      if (!result.categories.languageEthics) errors.push('Missing languageEthics');
    }

    // extractedText validation
    if (!result.extractedText) {
      errors.push('Missing extractedText');
    }

    return errors;
  }

  /**
   * Validate number detection to catch false positives (Fix #2)
   */
  validateNumberDetection(result) {
    const candidateNumberItem = result.categories?.prohibitedContent?.items?.find(
      item => item.rule === 'CANDIDATE_NUMBER'
    );

    if (candidateNumberItem?.found) {
      const details = candidateNumberItem.details?.toLowerCase() || '';
      const extractedText = result.extractedText?.rawText?.toLowerCase() || '';

      // Check for false positive indicators
      const falsePositivePatterns = [
        /\d{8,}/,  // Phone numbers (8+ digits)
        /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/,  // Dates
        /سنة.*\d+|\d+.*سنة/,  // Age mentions
        /للتواصل.*\d+|\d+.*للتواصل/,  // Contact numbers
        /رؤية.*\d{4}|\d{4}.*رؤية/,  // Vision statements
      ];

      // If details suggest false positive, add warning
      for (const pattern of falsePositivePatterns) {
        if (pattern.test(details) || pattern.test(extractedText)) {
          if (!result.warnings) result.warnings = [];
          result.warnings.push({
            type: 'POSSIBLE_FALSE_POSITIVE',
            rule: 'CANDIDATE_NUMBER',
            message: 'Number detection may be false positive (phone/date/age). Verify context.',
            details: candidateNumberItem.details,
            confidence: 60
          });
          break;
        }
      }

      // Check if "رقم المرشح" or "المرشح رقم" exists (true positive indicator)
      const hasCandidateContext = /رقم\s*المرشح|المرشح\s*رقم/.test(extractedText);
      if (!hasCandidateContext) {
        if (!result.warnings) result.warnings = [];
        result.warnings.push({
          type: 'MISSING_CONTEXT',
          rule: 'CANDIDATE_NUMBER',
          message: 'Number flagged but missing "رقم المرشح" context. May be phone/date/age.',
          confidence: 70
        });
      }
    }
  }

  /**
   * Deterministic validation for prohibited text patterns
   * acts as a safety net when AI misses explicit violations
   */
  validateTextContent(result) {
    const text = result.extractedText?.rawText || "";

    // 1. Check for "Job Seeker File" (Opening/Handling)
    // Pattern: "فتح ملف الباحثين" or "ملف الباحثين"
    const jobSeekerPattern = /فتح\s*ملف\s*باحثين|ملف\s*الباحثين/i;
    if (jobSeekerPattern.test(text)) {
      const match = text.match(jobSeekerPattern)[0];
      this.flagDeterministicViolation(result, {
        rule: "OBJECTIVES_OUTSIDE_POWERS",
        violatingObjectives: [match],
        explanation: "Prohibited content: 'Job Seeker File' (ملف الباحثين) is an executive authority matter."
      }, "Prohibited content: Mentioning 'Job Seeker File' (ملف الباحثين) is strictly prohibited.");
    }

    // 2. Check for "Ensuring Services Complete" (guaranteeing outcome)
    // Pattern: "أن تكون ... مكتملة" or "ضمان ... خدمات"
    const completeServicePattern = /أن\s*تكون.*مكتملة|ضمان.*خدمات|ضمان.*حصول/i;
    if (completeServicePattern.test(text)) {
      const match = text.match(completeServicePattern)[0];
      this.flagDeterministicViolation(result, {
        rule: "OBJECTIVES_OUTSIDE_POWERS",
        violatingObjectives: [match],
        explanation: "Prohibited content: Guaranteeing services or completeness is outside Shura powers."
      }, "Prohibited content: Candidates cannot guarantee service completion or outcomes.");
    }

    // 3. Check for "Seek to obtain" (Executive promise)
    // Pattern: "سأسعى على حصول" or "سأسعى للحصول"
    const seekObtainPattern = /سأسعى\s*(على|لـ?)\s*حصول/i;
    if (seekObtainPattern.test(text)) {
      const match = text.match(seekObtainPattern)[0];
      this.flagDeterministicViolation(result, {
        rule: "ELECTION_PROMISES",
        violatingObjectives: [match],
        explanation: "Prohibited Grammar: 'Seeking to obtain' (سأسعى للحصول) implies executive benefit delivery."
      }, "Prohibited language: 'Seeking to obtain' (سأسعى للحصول) is a prohibited form of promise.");
    }
  }

  /**
   * Helper to apply a deterministic violation
   */
  flagDeterministicViolation(result, violationData, rejectionMsg) {
    // 1. Mark as non-compliant
    result.isCompliant = false;
    result.overallScore = 0;

    // 2. Set rejection reason if empty
    if (!result.rejectionReason) {
      result.rejectionReason = rejectionMsg;
    } else if (!result.rejectionReason.includes(rejectionMsg)) {
      // Append if different
      result.rejectionReason += ` | ${rejectionMsg}`;
    }

    // 3. Add to content scope violations
    if (!result.categories) result.categories = {};
    if (!result.categories.contentScope) result.categories.contentScope = { status: "fail", items: [] };

    // Check if duplicate exists
    const exists = result.categories.contentScope.items.some(item =>
      item.rule === violationData.rule && item.violatingObjectives?.[0] === violationData.violatingObjectives[0]
    );

    if (!exists) {
      result.categories.contentScope.status = "fail";
      result.categories.contentScope.items.push({
        rule: violationData.rule,
        violated: true,
        confidence: 100,
        violatingObjectives: violationData.violatingObjectives,
        explanation: violationData.explanation
      });
    }

    // 4. Update trace to reflect system intervention
    if (result._analysis_trace) {
      result._analysis_trace.step4_decision_logic += ` [System enforced violation: ${violationData.explanation}]`;
    }
  }

  /**
   * Calculate confidence based on analysis trace quality
   */
  calculateConfidence(result) {
    let confidence = 90; // Base confidence

    const trace = result._analysis_trace;

    // Reduce confidence if trace is empty/generic
    if (!trace.step1_content_extraction || trace.step1_content_extraction === "Not provided") {
      confidence -= 20;
    }

    if (!trace.step3_violations_found || trace.step3_violations_found.length === 0) {
      if (!result.isCompliant) {
        confidence -= 10; // Non-compliant but no violations listed in trace
      }
    }

    // Increase confidence if document type reasoning is clear
    if (result.documentType?.reasoning && result.documentType.reasoning.length > 20) {
      confidence += 5;
    }

    // Reduce confidence for low model confidence scores
    const avgConfidence = this.getAverageItemConfidence(result);
    if (avgConfidence < 70) {
      confidence -= 10;
    }

    return Math.max(50, Math.min(100, confidence));
  }

  /**
   * Get average confidence from all violation items
   */
  getAverageItemConfidence(result) {
    const confidences = [];

    result.categories?.prohibitedContent?.items?.forEach(item => {
      if (item.confidence) confidences.push(item.confidence);
    });

    result.categories?.contentScope?.items?.forEach(item => {
      if (item.confidence) confidences.push(item.confidence);
    });

    if (confidences.length === 0) return 85;

    return confidences.reduce((a, b) => a + b, 0) / confidences.length;
  }

  /**
   * Generate rejection reason from result
   */
  generateRejectionReason(result) {
    // Check document type first
    if (result.documentType && !result.documentType.isElectionPropaganda) {
      const typeMap = {
        'training_ad': "The request is an advertisement for a training course and not an election advertisement for the candidate",
        'press_interview': "The attached document is a press interview and not election propaganda",
        'proposal': "The publication has nothing to do with election propaganda. Rather, it is a proposal to solve a problem",
        'social_post': "The post has nothing to do with election propaganda"
      };
      return typeMap[result.documentType.actualType] || "This is not election propaganda";
    }

    // Check image quality
    if (result.imageQuality && !result.imageQuality.isAcceptable) {
      if (result.imageQuality.issues.includes('blurry')) {
        return "Photo is blurry";
      }
    }

    // Check prohibited content
    const prohibited = result.categories?.prohibitedContent?.items || [];
    const violations = prohibited.filter(item => item.found);

    const hasNumber = violations.find(v => v.rule === 'CANDIDATE_NUMBER');
    const hasLogo = violations.find(v => v.rule === 'ELECTION_LOGO');

    if (hasNumber && hasLogo) {
      return "Removal of the candidate's number and election logo is required";
    }
    if (hasNumber) {
      return "Please remove the candidate number";
    }
    if (hasLogo) {
      return "Please remove the election logo";
    }

    const historical = violations.find(v => v.rule === 'HISTORICAL_SYMBOLS');
    if (historical) {
      const detail = historical.details.toLowerCase();
      if (detail.includes('fort') || detail.includes('castle')) {
        return "Please remove the fort/castle from the image background as it is a historical symbol";
      }
      if (detail.includes('gate')) {
        return "Please remove the gate from the image background as it is a historical symbol";
      }
      return "Please remove the historical symbol from the image background";
    }

    const publicFigures = violations.find(v => v.rule === 'PUBLIC_FIGURES');
    if (publicFigures) {
      return "The poster contains public figures";
    }

    const stateEmblem = violations.find(v => v.rule === 'STATE_EMBLEM');
    if (stateEmblem) {
      return "Please remove the state emblem";
    }

    const flag = violations.find(v => v.rule === 'NATIONAL_FLAG');
    if (flag) {
      return "Please remove the national flag";
    }

    // Check content scope
    const contentScope = result.categories?.contentScope?.items || [];
    const scopeViolations = contentScope.filter(item => item.violated);

    const outsidePowers = scopeViolations.find(v => v.rule === 'OBJECTIVES_OUTSIDE_POWERS');
    if (outsidePowers) {
      return "Most of the objectives mentioned fall outside the legally defined powers of the Shura Council members";
    }

    const promise = scopeViolations.find(v => v.rule === 'ELECTION_PROMISES');
    if (promise) {
      return "The content of the objective involves an election promise";
    }

    const deviation = scopeViolations.find(v => v.rule === 'DEVIATION_FROM_SCOPE');
    if (deviation) {
      return "The poster deviated from the content of the election campaign, which includes the candidate's picture, biography, electoral vision, goals, or roles";
    }

    const previousTerm = scopeViolations.find(v => v.rule === 'PREVIOUS_TERM_EXPLOITATION');
    if (previousTerm) {
      return "Cannot exploit the previous term achievements";
    }

    // Check required content
    const required = result.categories?.requiredContent?.items || [];
    const missingPhoto = required.find(item => item.element === 'CANDIDATE_PHOTO' && !item.present);
    const missingName = required.find(item => item.element === 'CANDIDATE_NAME' && !item.present);

    if (missingPhoto || missingName) {
      return "Election campaigning is limited to the following: candidate photo, name, CV, and vision";
    }

    // Default
    return "Poster does not comply with election campaign regulations";
  }
}

/**
 * Factory function for easy usage
 */
export async function validatePoster(imageBuffer) {
  const service = new ValidationService();
  return await service.validatePoster(imageBuffer);
}

/**
 * Batch validation for multiple images
 */
export async function validatePosters(imageBuffers) {
  const service = new ValidationService();
  const results = [];

  for (const buffer of imageBuffers) {
    const result = await service.validatePoster(buffer);
    results.push(result);
  }

  return results;
}