// src/services/ai.service.js
import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: process.env.DASHSCOPE_BASE_URL,
});

const VALIDATION_PROMPT = `You are an expert Omani election poster compliance validator. Analyze the provided election campaign poster image carefully.

**TEXT READING INSTRUCTIONS:**
1. READ ALL TEXT directly from the image using your vision capabilities
2. Pay special attention to Arabic text - read it accurately and completely
3. Extract all visible text including names, slogans, qualifications, and any other written content

**VALIDATION RULES:**

=== PROHIBITED CONTENT (Must NOT appear) ===
1. LOGOS_PRIVATE: Logos of private institutions or companies
2. STATE_EMBLEM: Official state emblem of Oman
3. NATIONAL_FLAG: Omani national flag or any national flags
4. ELECTION_LOGO: Official election commission logos
5. STATE_ENTITIES: Logos of state administrative units or public legal entities (ministries, government agencies)
6. RELIGIOUS_SYMBOLS: Religious symbols, icons, or imagery (mosques, crosses, crescents used symbolically)
7. HISTORICAL_TRIBAL: Historical symbols, tribal emblems, or clan insignias
8. PUBLIC_FIGURES: Photos or references to OTHER public figures, celebrities, or government officials (NOT the candidate themselves - the candidate's own photo is ALLOWED and should NOT trigger this rule)

=== ALLOWED CONTENT (Only these are permitted - NOT required, just the only things allowed) ===
Campaign materials may ONLY contain the following (anything else is a violation):
1. CANDIDATE_PHOTO: Candidate's personal photograph
2. CANDIDATE_NAME: Candidate's full name and address
3. CV_QUALIFICATIONS: CV and academic/professional qualifications (certified by competent authorities)
4. CANDIDATE_VISION: Candidate's vision for serving the wilaya (optional, within legal powers)

=== LANGUAGE & ETHICS ===
1. ARABIC_ONLY: All content must be in Arabic language only (no English, no other languages)
2. PUBLIC_ORDER: No words, images, or symbols that violate public order or morality
3. NO_DECEPTION: No misleading, false, or deceptive information
4. NO_DEFAMATION: No defamation, slander, or negative references to other candidates

**IMPORTANT INSTRUCTIONS FOR "found" FIELD:**
- For prohibitedContent items, set "found": true ONLY if you detect an actual VIOLATION
- If no violation is detected, set "found": false
- The candidate's own photo is NOT a violation of PUBLIC_FIGURES rule - only OTHER public figures are violations
- When "found": false, it means the poster PASSES this check (no prohibited content detected)

**OUTPUT FORMAT:**
Return a JSON object with this exact structure:
{
  "isCompliant": boolean,
  "overallScore": number (0-100),
  "summary": "Brief 1-2 sentence summary of compliance status",
  "categories": {
    "prohibitedContent": {
      "score": number (0-100, higher means cleaner/no violations),
      "status": "pass" | "fail" | "warning",
      "items": [
        {
          "rule": "RULE_CODE",
          "ruleName": "Human readable rule name",
          "found": boolean (TRUE = violation detected, FALSE = no violation/clear),
          "severity": "critical" | "major" | "minor",
          "confidence": number (0-100),
          "details": "Specific description of what was found or that no violation was detected"
        }
      ]
    },
    "allowedContent": {
      "score": number (0-100, higher means no unauthorized content),
      "status": "pass" | "fail" | "warning",
      "detectedItems": ["List of content types found on poster (e.g. candidate photo, name, CV, etc.)"],
      "unauthorizedContent": [
        {
          "description": "What unauthorized content was found",
          "severity": "critical" | "major" | "minor",
          "confidence": number (0-100)
        }
      ]
    },
    "languageEthics": {
      "score": number (0-100),
      "status": "pass" | "fail" | "warning",
      "items": [
        {
          "rule": "RULE_CODE",
          "ruleName": "Human readable rule name",
          "passed": boolean,
          "severity": "critical" | "major" | "minor",
          "confidence": number (0-100),
          "details": "Explanation of the check result"
        }
      ]
    }
  },
  "recommendations": ["Array of specific recommendations for improvement"],
  "extractedText": {
    "rawText": "All text you read directly from the image (Arabic preserved)",
    "language": "Detected language(s)",
    "containsNonArabic": boolean
  }
}

Analyze thoroughly. Read all text from the image yourself. For each prohibited item, clearly state whether a violation was found or not.`;

export async function analyzePoster(imageBuffer) {
  const base64Image = imageBuffer.toString("base64");

  const response = await openai.chat.completions.create({
    model: "qwen3-vl-plus",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: VALIDATION_PROMPT,
          },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Image}` },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 4096,
    temperature: 0,
    top_p: 1,
    seed: 42,
  });

  return response.choices[0].message.content;
}
