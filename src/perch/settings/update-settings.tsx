// "Updates" on the settings screen (docs/design.md "Updates"): the running version, "Check for updates", and once a
// newer version is found, "Update to v<version>" with the download progress. Up to date / check failed only come
// from a manual check (src-tauri/src/updater.rs)
import { t } from "@/lib/i18n";
import { BusyButton } from "./busy-button";
import type { UpdateStatus } from "../use-updates";

type Props = {
  status: UpdateStatus;
  version: string | null;
  onCheck: () => void;
  onInstall: () => void;
};

export function UpdateSettings({ status, version, onCheck, onInstall }: Props) {
  return (
    <section className="update-settings">
      <h2>{t("updatesHeading")}</h2>
      {version && <p className="update-version">{t("updatesCurrentVersion", version)}</p>}
      <UpdateBody status={status} onCheck={onCheck} onInstall={onInstall} />
    </section>
  );
}

function UpdateBody({ status, onCheck, onInstall }: Omit<Props, "version">) {
  switch (status.kind) {
    case "available":
    case "installFailed":
      return (
        <>
          {/* The one main action of this section: emphasized, unlike the small "Check for updates" */}
          <button className="update-install" onClick={onInstall}>
            {t("updatesInstallButton", status.version)}
          </button>
          {status.kind === "installFailed" ? (
            <p className="judge-status judge-status-error" role="alert">
              {t("updatesInstallFailed")}
            </p>
          ) : (
            <p className="settings-note">{t("updatesRestartNote")}</p>
          )}
        </>
      );
    case "downloading": {
      const percent = status.total ? Math.min(100, Math.floor((status.downloaded * 100) / status.total)) : null;
      return (
        <div className="update-progress" role="status">
          {t("updatesDownloading")}
          <div className="update-progress-bar">
            {/* No value while the size is unknown: an indeterminate bar */}
            <progress max={100} value={percent ?? undefined} />
            <span className="volume-value">{percent === null ? "" : `${percent}%`}</span>
          </div>
        </div>
      );
    }
    case "installing":
      return (
        <div className="update-progress" role="status">
          {t("updatesInstalling")}
          <p className="settings-note">{t("updatesRestartNote")}</p>
        </div>
      );
    default:
      return (
        <>
          <BusyButton
            label={t("updatesCheckButton")}
            busyLabel={t("updatesChecking")}
            busy={status.kind === "checking"}
            onClick={onCheck}
          />
          {status.kind === "upToDate" && <p className="judge-status judge-status-ok">{t("updatesUpToDate")}</p>}
          {status.kind === "checkFailed" && (
            <p className="judge-status judge-status-error" role="alert">
              {t("updatesCheckFailed")}
            </p>
          )}
        </>
      );
  }
}
