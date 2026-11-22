/**
 * Owner of the per-class concurrency slot counts.
 *
 * The global slot count is not kept here: it lives inside the concurrency
 * gate (`createReconfigurableBulkhead`), which grants and takes back the
 * slot itself. This module only records which class a granted slot belongs
 * to. Nothing outside this file writes these counts; a class is always
 * named by its id.
 */

type ClassSlotCounters = {
  /** Slots this class holds right now. */
  inFlight: number;
  /** Admissions whose concurrency slot came from shared capacity. */
  totalBorrowedAdmissions: number;
};

export function createClassSlots(classIds: Iterable<string>) {
  const perClass = new Map<string, ClassSlotCounters>();
  for (const id of classIds) {
    perClass.set(id, { inFlight: 0, totalBorrowedAdmissions: 0 });
  }

  /**
   * Admission: the class takes the slot the call was just granted.
   * `borrowed` is true when that slot sits above the class's floor.
   */
  function occupy(classId: string | undefined, borrowed: boolean): void {
    if (classId === undefined) return;
    const cls = perClass.get(classId)!;
    cls.inFlight++;
    cls.totalBorrowedAdmissions += borrowed ? 1 : 0;
  }

  /** Release or abandonment: the class gives the slot back. */
  function vacate(classId: string | undefined): void {
    if (classId === undefined) return;
    const cls = perClass.get(classId)!;
    cls.inFlight = Math.max(0, cls.inFlight - 1);
  }

  return {
    occupy,
    vacate,
    /** Slots one class holds right now. */
    inFlight: (classId: string): number => perClass.get(classId)!.inFlight,
    /** A live read of one class's held slots, without a lookup per read. */
    reader: (classId: string): (() => number) => {
      const cls = perClass.get(classId)!;
      return () => cls.inFlight;
    },
    totalBorrowedAdmissions: (classId: string): number =>
      perClass.get(classId)!.totalBorrowedAdmissions,
  };
}

export type ClassSlots = ReturnType<typeof createClassSlots>;
