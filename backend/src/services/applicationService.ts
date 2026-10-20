/**
 * Application Service
 * Orchestrates tenant application workflow
 */

import {
  listingApplicationRepository,
  IListingApplicationRepository,
} from "../repositories/ListingApplicationRepository.js";
import {
  ListingApplication,
  ListingApplicationStatus,
  CreateListingApplicationInput,
  RtiAssessment,
} from "../models/listingApplication.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { auditLog, AuditContext } from "../utils/auditLogger.js";
import { outboxStore } from "../outbox/index.js";
import { logger } from "../utils/logger.js";
import { listingStore } from "../models/listingStore.js";
import { computeRti } from "./rtiAssessmentService.js";
import { deriveReviewRepayment } from "./reviewRepayment.js";

export class ApplicationService {
  constructor(
    private applicationRepository: IListingApplicationRepository = listingApplicationRepository,
  ) {}

  /**
   * Tenant applies for a listing
   */
  async apply(
    input: CreateListingApplicationInput,
  ): Promise<ListingApplication> {
    // Validate preferred start date is at least 7 days in the future
    const preferredDate = new Date(input.preferredStartDate);
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + 7);

    if (preferredDate < minDate) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        400,
        "Preferred start date must be at least 7 days in the future",
      );
    }

    // Check for existing active application
    const existing = await this.applicationRepository.findDuplicateActive(
      input.tenantId,
      input.listingId,
    );

    if (existing) {
      throw new AppError(
        ErrorCode.CONFLICT,
        409,
        `Tenant already has an active application for this listing (${existing.status})`,
      );
    }

    // Create application
    const application = await this.applicationRepository.create(input);

    // Audit log
    auditLog(
      "STATE_CHANGED",
      {
        userId: input.tenantId,
        requestId: "unknown",
        ip: "unknown",
        actorType: "user",
      },
      {
        listingId: input.listingId,
        paymentPlan: input.paymentPlan,
        applicationId: application.id,
        action: "LISTING_APPLICATION_SUBMITTED",
      },
    );

    // Emit event for notification
    await outboxStore.create({
      txType: "RECEIPT" as any, // Placeholder
      source: "application",
      ref: application.id,
      payload: {
        type: "ApplicationSubmitted",
        tenantId: input.tenantId,
        listingId: input.listingId,
        applicationId: application.id,
      },
    });

    logger.info(
      `Tenant ${input.tenantId} applied for listing ${input.listingId}`,
    );
    return application;
  }

  /**
   * Landlord reviews and approves/rejects application
   */
  async reviewApplication(
    applicationId: string,
    landlordId: string,
    decision: "approve" | "reject",
    notes?: string,
  ): Promise<ListingApplication> {
    const application =
      await this.applicationRepository.findById(applicationId);
    if (!application) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, "Application not found");
    }

    // Verify landlord owns the listing
    if (application.landlordId !== landlordId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        "You can only review applications for your own listings",
      );
    }

    const status =
      decision === "approve"
        ? ListingApplicationStatus.APPROVED
        : ListingApplicationStatus.REJECTED;

    // Compute RTI against the instalment the deal would actually charge.
    // When the terms cannot be priced, no assessment is stored and the reason
    // is recorded instead of a placeholder repayment (issue #1953).
    let rtiAssessment: RtiAssessment | undefined;
    let rtiUnavailableReason: string | undefined;
    const listing = await listingStore.getById(application.listingId);
    const repayment = deriveReviewRepayment({
      annualRentNgn: listing?.annualRentNgn ?? null,
      paymentPlan: application.paymentPlan,
    });
    if (repayment.available) {
      try {
        rtiAssessment = {
          ...computeRti(application.tenantId, repayment.monthlyRepayment),
          repaymentBasis: repayment.basis,
        };
      } catch (error) {
        logger.warn("Failed to compute RTI assessment", {
          applicationId,
          tenantId: application.tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the review if RTI computation fails - it's an optional signal
      }
    } else {
      rtiUnavailableReason = repayment.reason;
      logger.info("RTI assessment skipped: repayment terms unavailable", {
        applicationId,
        reason: repayment.reason,
      });
    }

    const updated = await this.applicationRepository.updateStatus(
      applicationId,
      status,
      landlordId,
      notes,
      rtiAssessment,
    );

    if (!updated) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        500,
        "Failed to update application status",
      );
    }

    // If approved, trigger deal creation
    if (decision === "approve") {
      await this.initiateDelivery(applicationId);
    }

    // Audit log
    auditLog(
      decision === "approve" ? "LISTING_APPROVED" : "LISTING_REJECTED",
      {
        userId: landlordId,
        requestId: "unknown",
        ip: "unknown",
        actorType: "user",
      },
      {
        applicationId,
        decision,
        notes,
        rtiVerdict: rtiAssessment?.verdict,
        rtiUnavailableReason,
      },
    );

    // Emit event for notification
    await outboxStore.create({
      txType: "RECEIPT" as any,
      source: "application",
      ref: applicationId,
      payload: {
        type: `ApplicationApproved`,
        tenantId: application.tenantId,
        listingId: application.listingId,
        applicationId,
        rtiAssessment,
      },
    });

    logger.info(
      `Application ${applicationId} ${decision}ed by landlord ${landlordId}`,
      { rtiVerdict: rtiAssessment?.verdict },
    );
    return updated;
  }

  /**
   * Tenant withdraws application
   */
  async withdrawApplication(
    applicationId: string,
    tenantId: string,
  ): Promise<ListingApplication> {
    const application =
      await this.applicationRepository.findById(applicationId);
    if (!application) {
      throw new AppError(ErrorCode.NOT_FOUND, 404, "Application not found");
    }

    // Verify tenant owns the application
    if (application.tenantId !== tenantId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        "You can only withdraw your own applications",
      );
    }

    // Can only withdraw pending or under review applications
    if (
      ![
        ListingApplicationStatus.PENDING,
        ListingApplicationStatus.UNDER_REVIEW,
      ].includes(application.status)
    ) {
      throw new AppError(
        ErrorCode.CONFLICT,
        409,
        `Cannot withdraw application in ${application.status} status`,
      );
    }

    const updated = await this.applicationRepository.withdraw(applicationId);

    // Audit log
    auditLog(
      "STATE_CHANGED",
      {
        userId: tenantId,
        requestId: "unknown",
        ip: "unknown",
        actorType: "user",
      },
      {
        applicationId,
        fromStatus: application.status,
        toStatus: "withdrawn",
      },
    );

    logger.info(`Application ${applicationId} withdrawn by tenant ${tenantId}`);
    return updated!;
  }

  /**
   * Initiate deal creation on approval
   */
  private async initiateDelivery(applicationId: string): Promise<void> {
    const application =
      await this.applicationRepository.findById(applicationId);
    if (!application) return;

    // In production, call dealService.createDeal()
    // For now, emit event that triggers deal creation
    await outboxStore.create({
      txType: "RECEIPT" as any,
      source: "application",
      ref: applicationId,
      payload: {
        type: "InitiateDealCreation",
        tenantId: application.tenantId,
        listingId: application.listingId,
        applicationId,
      },
    });

    logger.info(`Initiated deal creation for application ${applicationId}`);
  }
}

export const applicationService = new ApplicationService();
