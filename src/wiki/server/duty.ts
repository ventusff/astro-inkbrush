/**
 * Whether this process runs the CMS's background tasks: the inbox importer,
 * the share follower and the snapshot warmer.
 *
 * A site that serves one state directory from more than one process at a
 * time — a rolling deploy keeps the outgoing and the incoming instance up
 * together — names one of them on duty through `inkbrush({ onDuty })`.
 * Every background task asks before each run and skips that run off duty;
 * request-triggered work (a manual import, a share, a publish) runs
 * wherever the request lands. Without the option every process is on duty.
 */

let check: () => boolean = () => true;

/** install the site's duty verdict; undefined = always on duty */
export function setDutyCheck(next: (() => boolean) | undefined): void {
  check = next ?? (() => true);
}

/** this process runs background tasks right now. A verdict that throws
 *  counts as off duty: two processes running a task at once is what the
 *  check exists to prevent. */
export function onDuty(): boolean {
  try {
    return check() === true;
  } catch (err) {
    console.error('[wiki] the site\'s onDuty check failed — background tasks skip this run:', err);
    return false;
  }
}
