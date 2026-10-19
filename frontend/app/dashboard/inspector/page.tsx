"use client";

import { useCallback, useEffect, useState } from "react";
import { DashboardHeader } from "@/components/dashboard-header";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  propertyInspectionApi,
  type InspectionJob,
} from "@/lib/propertyInspectionApi";
import useAuthStore from "@/store/useAuthStore";

export default function InspectorDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const [jobs, setJobs] = useState<InspectionJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acceptingJobId, setAcceptingJobId] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      setJobs(await propertyInspectionApi.getAvailableJobs());
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load inspection jobs.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const acceptJob = async (jobId: string) => {
    setAcceptingJobId(jobId);
    setError(null);

    try {
      await propertyInspectionApi.acceptJob(jobId);
      await loadJobs();
    } catch (acceptError) {
      setError(
        acceptError instanceof Error
          ? acceptError.message
          : "Unable to accept this inspection job.",
      );
    } finally {
      setAcceptingJobId(null);
    }
  };

  const userName = user?.name?.trim() || "Inspector";

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 md:grid-cols-[240px_minmax(0,1fr)]">
        <DashboardSidebar
          role="inspector"
          userInfo={{ name: userName, roleLabel: "Property Inspector" }}
        />
        <main id="dashboard-main-content" className="min-w-0 space-y-6">
          <div>
            <h1 className="text-2xl font-bold">Inspection jobs</h1>
            <p className="mt-1 text-muted-foreground">
              Review available property inspections and manage your assignments.
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 border border-destructive/50 bg-destructive/5 p-4 text-sm"
            >
              <span>{error}</span>
              <Button variant="outline" onClick={() => void loadJobs()}>
                Try again
              </Button>
            </div>
          )}

          {isLoading ? (
            <p role="status" className="py-8 text-center text-muted-foreground">
              Loading inspection jobs...
            </p>
          ) : jobs.length === 0 ? (
            <Card className="p-8 text-center">
              <h2 className="text-lg font-semibold">No available jobs</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                New inspection requests will appear here.
              </p>
            </Card>
          ) : (
            <ul className="space-y-3">
              {jobs.map((job) => (
                <li key={job.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <h2 className="font-semibold">
                        {job.propertyTitle || job.address || `Listing ${job.listingId}`}
                      </h2>
                      {job.address && job.propertyTitle && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {job.address}
                        </p>
                      )}
                      <p className="mt-1 text-sm text-muted-foreground">
                        {job.inspectionType === "re_inspection"
                          ? "Re-inspection"
                          : "New listing inspection"}
                        {job.deadline && ` · Due ${new Date(job.deadline).toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {typeof job.offeredFee === "number" && (
                        <span className="text-sm font-medium">
                          ₦{job.offeredFee.toLocaleString()}
                        </span>
                      )}
                      <Button
                        onClick={() => void acceptJob(job.id)}
                        disabled={acceptingJobId !== null}
                      >
                        {acceptingJobId === job.id ? "Accepting..." : "Accept job"}
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}