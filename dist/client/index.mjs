// src/shared/result.ts
function isToolResult(v) {
  if (v === null || typeof v !== "object") return false;
  const o = v;
  return typeof o.schemaVersion === "string" && typeof o.kind === "string" && typeof o.ok === "boolean" && Array.isArray(o.diagnostics);
}

// src/shared/status.ts
var VERDICT_STATUSES = [
  "VERIFIED",
  "PARTIAL",
  "FAILED",
  "STALE",
  "UNVERIFIED",
  "NOT_APPLICABLE"
];
function isVerdictStatus(v) {
  return typeof v === "string" && VERDICT_STATUSES.includes(v);
}
var STATUS_LABELS = {
  VERIFIED: "\u5DF2\u9A8C\u8BC1",
  PARTIAL: "\u90E8\u5206\u9A8C\u8BC1",
  FAILED: "\u5931\u8D25",
  STALE: "\u5DF2\u8FC7\u671F\uFF08\u4EE3\u7801\u5DF2\u53D8\u5316\uFF0C\u9700\u91CD\u9A8C\uFF09",
  UNVERIFIED: "\u672A\u9A8C\u8BC1",
  NOT_APPLICABLE: "\u4E0D\u9002\u7528"
};

// src/client/projection/canonical-result.ts
var SUPPORTED_RESULT_SCHEMA = "1.0";
function parseCanonicalResult(raw) {
  if (!isToolResult(raw)) return null;
  if (raw.schemaVersion !== SUPPORTED_RESULT_SCHEMA) {
    return {
      kind: raw.kind,
      ok: false,
      data: null,
      error: { code: "CP_SCHEMA_VERSION_UNSUPPORTED", message: `unsupported tool-result schemaVersion "${raw.schemaVersion}" (client supports ${SUPPORTED_RESULT_SCHEMA})` },
      diagnostics: []
    };
  }
  return {
    kind: raw.kind,
    ok: raw.ok,
    data: raw.data ?? null,
    error: raw.error ? { code: raw.error.code, message: raw.error.message } : null,
    diagnostics: raw.diagnostics ?? []
  };
}
function extractVerdictStatus(result) {
  if (!result.ok || !result.data) return null;
  const data = result.data;
  if (result.kind === "changeproof_verify") {
    const verdict = data["verdict"];
    const status = verdict?.["status"];
    return isVerdictStatus(status) ? status : null;
  }
  if (result.kind === "changeproof_status") {
    const freshness = data["freshness"];
    if (freshness === "stale") return "STALE";
    return null;
  }
  return null;
}

// src/client/projection/freshness-reducer.ts
var INITIAL_CLIENT_STATE = {
  status: null,
  pendingHostConfirmation: false,
  evidenceAgeIso: null,
  blockers: [],
  changedLineCoverage: null,
  coverageSummary: null,
  lastResultKind: null,
  errorMessage: null
};
var MUTATION_TOOL_PATTERNS = [/write/i, /edit/i, /apply/i, /patch/i, /delete/i, /remove/i, /move/i, /create/i];
function isLikelyMutationTool(toolId) {
  return MUTATION_TOOL_PATTERNS.some((re) => re.test(toolId));
}
function clientReducer(state, event) {
  switch (event.type) {
    case "reset":
      return { ...INITIAL_CLIENT_STATE };
    case "mutation-observed": {
      if (state.status === null || state.status === "UNVERIFIED") return state;
      return {
        ...state,
        status: "STALE",
        pendingHostConfirmation: true,
        blockers: [
          {
            code: "CP_CLIENT_CONSERVATIVE_STALE",
            message: `observed possible workspace mutation (${event.toolId}); waiting for host confirmation via changeproof_status/verify`,
            blocking: true
          }
        ]
      };
    }
    case "tool-result": {
      const parsed = parseCanonicalResult(event.raw);
      if (!parsed) return state;
      if (!parsed.kind.startsWith("changeproof_")) {
        return isLikelyMutationTool(parsed.kind) ? clientReducer(state, { type: "mutation-observed", toolId: parsed.kind, at: (/* @__PURE__ */ new Date()).toISOString() }) : state;
      }
      const next = { ...state, lastResultKind: parsed.kind, errorMessage: parsed.error ? `${parsed.error.code}: ${parsed.error.message}` : null };
      if (!parsed.ok || !parsed.data) {
        if (parsed.kind === "changeproof_plan") return next;
        return { ...next, status: "UNVERIFIED", pendingHostConfirmation: false, blockers: parsed.error ? [{ code: parsed.error.code, message: parsed.error.message, blocking: true }] : [] };
      }
      const status = extractVerdictStatus(parsed);
      const data = parsed.data;
      const verdict = data["verdict"] ?? null;
      const covSummary = data["changedLineCoverageSummary"] ?? null;
      return {
        ...next,
        status: status ?? next.status,
        pendingHostConfirmation: false,
        evidenceAgeIso: verdict?.["evaluatedAt"] ?? next.evidenceAgeIso,
        blockers: (verdict?.["reasons"] ?? []).filter((r) => r.blocking),
        changedLineCoverage: verdict ? {
          threshold: verdict["changedLineCoverage"]?.threshold ?? 1,
          actual: verdict["changedLineCoverage"]?.actual ?? null
        } : next.changedLineCoverage,
        coverageSummary: covSummary ? {
          covered: Number(covSummary["coveredTotal"] ?? 0),
          coverable: Number(covSummary["coverableTotal"] ?? 0),
          uncovered: Number(covSummary["uncoveredTotal"] ?? 0)
        } : next.coverageSummary
      };
    }
  }
}

// src/client/styles/proofboard.module.css
var proofboard_default = {
  board: "proofboard_board",
  boardWide: "proofboard_boardWide",
  section: "proofboard_section",
  sectionTitle: "proofboard_sectionTitle",
  chip: "proofboard_chip",
  chipIcon: "proofboard_chipIcon",
  severityOk: "proofboard_severityOk",
  severityWarn: "proofboard_severityWarn",
  severityError: "proofboard_severityError",
  severityInfo: "proofboard_severityInfo",
  severityMuted: "proofboard_severityMuted",
  table: "proofboard_table",
  mono: "proofboard_mono",
  blocker: "proofboard_blocker",
  dock: "proofboard_dock",
  button: "proofboard_button",
  buttonPrimary: "proofboard_buttonPrimary",
  empty: "proofboard_empty",
  announcement: "proofboard_announcement"
};

// src/client/components/StatusChip.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var ICONS = {
  VERIFIED: "\u2713",
  PARTIAL: "\u25D0",
  FAILED: "\u2715",
  STALE: "\u21BB",
  UNVERIFIED: "?",
  NOT_APPLICABLE: "\u2205"
};
function StatusChip(props) {
  const { status, pendingHostConfirmation, evidenceAgeIso } = props;
  const severityClass = status === "VERIFIED" ? proofboard_default.severityOk : status === "FAILED" ? proofboard_default.severityError : status === "PARTIAL" || status === "STALE" ? proofboard_default.severityWarn : status === "NOT_APPLICABLE" ? proofboard_default.severityInfo : proofboard_default.severityMuted;
  const age = evidenceAgeIso ? evidenceAgeIso.slice(0, 19).replace("T", " ") + "Z" : null;
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      className: `${proofboard_default.chip} ${severityClass}`,
      onClick: props.onOpen,
      "aria-label": `ChangeProof \u72B6\u6001: ${STATUS_LABELS[status]}`,
      title: pendingHostConfirmation ? "\u4EE3\u7801\u5DF2\u53D8\u5316\uFF0C\u9700\u91CD\u9A8C\uFF08\u7B49\u5F85 Host \u786E\u8BA4\uFF09" : STATUS_LABELS[status],
      children: [
        /* @__PURE__ */ jsx("span", { className: proofboard_default.chipIcon, "aria-hidden": "true", children: ICONS[status] }),
        /* @__PURE__ */ jsx("span", { children: STATUS_LABELS[status] }),
        pendingHostConfirmation ? /* @__PURE__ */ jsx("span", { "aria-hidden": "true", children: "\xB7 \u5F85\u786E\u8BA4" }) : null,
        !props.compact && age ? /* @__PURE__ */ jsxs("span", { className: proofboard_default.mono, children: [
          "(",
          age,
          ")"
        ] }) : null
      ]
    }
  );
}

// src/client/components/ChangeSummary.tsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function ChangeSummary(props) {
  return /* @__PURE__ */ jsxs2("section", { className: proofboard_default.section, "aria-labelledby": "cp-change-title", children: [
    /* @__PURE__ */ jsxs2("h3", { id: "cp-change-title", className: proofboard_default.sectionTitle, children: [
      "\u53D8\u66F4\u6458\u8981 (",
      props.files.length,
      " \u4E2A\u6587\u4EF6 \xB7 ",
      props.mode === "git" ? "Git \u57FA\u7EBF" : "\u975E Git \u964D\u7EA7\uFF08\u4E0D\u53EF VERIFIED\uFF09",
      ")"
    ] }),
    /* @__PURE__ */ jsxs2("table", { className: proofboard_default.table, children: [
      /* @__PURE__ */ jsx2("thead", { children: /* @__PURE__ */ jsxs2("tr", { children: [
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u6587\u4EF6" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "\u72B6\u6001" }),
        /* @__PURE__ */ jsx2("th", { scope: "col", children: "+/-" })
      ] }) }),
      /* @__PURE__ */ jsxs2("tbody", { children: [
        props.files.map((f) => /* @__PURE__ */ jsxs2("tr", { children: [
          /* @__PURE__ */ jsx2("td", { className: proofboard_default.mono, children: f.path }),
          /* @__PURE__ */ jsx2("td", { children: f.status }),
          /* @__PURE__ */ jsxs2("td", { className: proofboard_default.mono, children: [
            "+",
            f.linesAdded,
            "/-",
            f.linesDeleted
          ] })
        ] }, f.path)),
        props.files.length === 0 ? /* @__PURE__ */ jsx2("tr", { children: /* @__PURE__ */ jsx2("td", { colSpan: 3, className: proofboard_default.empty, children: "\u5DE5\u4F5C\u533A\u65E0\u53D8\u66F4" }) }) : null
      ] })
    ] }),
    props.deletedLineRisk.length > 0 ? /* @__PURE__ */ jsxs2("p", { children: [
      "\u5220\u9664\u98CE\u9669\uFF08\u5220\u9664\u884C\u65E0\u6CD5\u88AB\u8986\u76D6\u8BC1\u660E\uFF0C\u9700\u76F8\u5173\u6D4B\u8BD5/\u9759\u6001\u68C0\u67E5/mutation \u4F50\u8BC1\uFF09\uFF1A",
      props.deletedLineRisk.map((d) => ` ${d.path} [${d.ranges.join(", ")}]`)
    ] }) : null
  ] });
}
function ImpactList(props) {
  const byPackage = /* @__PURE__ */ new Map();
  for (const c of props.candidates) {
    if (!byPackage.has(c.packageId)) byPackage.set(c.packageId, []);
    byPackage.get(c.packageId).push(c);
  }
  const sourceLabels = {
    explicit: "\u663E\u5F0F\u6620\u5C04",
    "coverage-history": "\u5386\u53F2 coverage map",
    "import-graph": "\u9759\u6001 import graph",
    naming: "\u547D\u540D\u7EA6\u5B9A"
  };
  return /* @__PURE__ */ jsxs2("section", { className: proofboard_default.section, "aria-labelledby": "cp-impact-title", children: [
    /* @__PURE__ */ jsxs2("h3", { id: "cp-impact-title", className: proofboard_default.sectionTitle, children: [
      "\u5019\u9009\u6D4B\u8BD5 (\u6700\u9AD8\u7F6E\u4FE1\u5EA6: ",
      props.maxConfidence,
      ")"
    ] }),
    props.candidates.length === 0 ? /* @__PURE__ */ jsx2("p", { className: proofboard_default.empty, children: "\u65E0\u5019\u9009\uFF1A\u76F8\u5173\u6D4B\u8BD5\u672A\u88AB\u627E\u5230\uFF0C\u7ED3\u8BBA\u4E0D\u4F1A\u662F VERIFIED" }) : /* @__PURE__ */ jsx2("ul", { children: [...byPackage.entries()].map(([pkg, cands]) => /* @__PURE__ */ jsxs2("li", { children: [
      /* @__PURE__ */ jsx2("strong", { children: pkg }),
      /* @__PURE__ */ jsx2("ul", { children: cands.map((c) => /* @__PURE__ */ jsxs2("li", { children: [
        /* @__PURE__ */ jsx2("span", { className: proofboard_default.mono, children: c.testFiles.join(", ") }),
        " \u2014 ",
        sourceLabels[c.source] ?? c.source,
        " (",
        c.confidence,
        ")"
      ] }, c.id)) })
    ] }, pkg)) })
  ] });
}

// src/client/components/CoverageTable.tsx
import { Fragment, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function CoverageTable(props) {
  return /* @__PURE__ */ jsxs3("section", { className: proofboard_default.section, "aria-labelledby": "cp-cov-title", children: [
    /* @__PURE__ */ jsxs3("h3", { id: "cp-cov-title", className: proofboard_default.sectionTitle, children: [
      "Changed-line coverage: ",
      props.summary.ratio === null ? "\u65E0\u6570\u636E" : `${props.summary.covered}/${props.summary.coverable} (${(props.summary.ratio * 100).toFixed(1)}%)`
    ] }),
    /* @__PURE__ */ jsxs3("table", { className: proofboard_default.table, children: [
      /* @__PURE__ */ jsx3("thead", { children: /* @__PURE__ */ jsxs3("tr", { children: [
        /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u6587\u4EF6" }),
        /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u8986\u76D6 / \u53EF\u6267\u884C" }),
        /* @__PURE__ */ jsx3("th", { scope: "col", children: "\u672A\u8986\u76D6\u884C" })
      ] }) }),
      /* @__PURE__ */ jsx3("tbody", { children: props.files.map((f) => /* @__PURE__ */ jsxs3("tr", { children: [
        /* @__PURE__ */ jsxs3("td", { className: proofboard_default.mono, children: [
          f.path,
          f.excluded ? `\uFF08\u5DF2\u6392\u9664: ${f.excluded}\uFF09` : "",
          f.absentFromArtifact ? "\uFF08\u672A\u51FA\u73B0\u5728 coverage \u4EA7\u7269\u4E2D\uFF09" : ""
        ] }),
        /* @__PURE__ */ jsxs3("td", { className: proofboard_default.mono, children: [
          f.covered.length,
          "/",
          f.coverable.length
        ] }),
        /* @__PURE__ */ jsx3("td", { className: proofboard_default.mono, children: f.uncovered.length > 0 ? f.uncovered.join(", ") : "\u2014" })
      ] }, f.path)) })
    ] })
  ] });
}
function EvidenceTimeline(props) {
  return /* @__PURE__ */ jsxs3("section", { className: proofboard_default.section, "aria-labelledby": "cp-ev-title", children: [
    /* @__PURE__ */ jsx3("h3", { id: "cp-ev-title", className: proofboard_default.sectionTitle, children: "\u8BC1\u636E\u65F6\u95F4\u7EBF" }),
    props.evidence.length === 0 ? /* @__PURE__ */ jsx3("p", { className: proofboard_default.empty, children: "\u5C1A\u65E0\u8BC1\u636E" }) : /* @__PURE__ */ jsx3("ol", { children: props.evidence.map((e) => /* @__PURE__ */ jsxs3("li", { children: [
      /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: e.stepId }),
      " \xB7 ",
      e.termination,
      e.exitCode !== null ? `(${e.exitCode})` : "",
      " \xB7 ",
      e.durationMs,
      "ms \xB7 cwd=",
      /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: e.cwd || "." }),
      /* @__PURE__ */ jsx3("br", {}),
      "argv: ",
      /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: e.argvRedacted.join(" ") }),
      /* @__PURE__ */ jsx3("br", {}),
      "artifact: ",
      /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: e.artifactDigests.map((a) => `${a.kind}:${a.digest.slice(7, 19)}`).join(", ") || "\u2014" })
    ] }, e.id)) })
  ] });
}
function BlockerList(props) {
  const needsUser = props.blockers.filter((b) => b.code.startsWith("CP_CONFIG") || b.code.includes("APPROVAL") || b.code.includes("NOT_FOUND"));
  const retryable = props.blockers.filter((b) => b.code === "CP_WORKSPACE_CHANGED_DURING_VERIFY" || b.code === "CP_FINGERPRINT_MISMATCH" || b.code === "CP_CLIENT_CONSERVATIVE_STALE");
  const capability = props.blockers.filter((b) => !needsUser.includes(b) && !retryable.includes(b));
  return /* @__PURE__ */ jsxs3("section", { className: proofboard_default.section, "aria-labelledby": "cp-blocker-title", children: [
    /* @__PURE__ */ jsx3("h3", { id: "cp-blocker-title", className: proofboard_default.sectionTitle, children: "\u963B\u585E\u539F\u56E0" }),
    props.blockers.length === 0 ? /* @__PURE__ */ jsx3("p", { className: proofboard_default.empty, children: "\u65E0\u963B\u585E" }) : /* @__PURE__ */ jsxs3(Fragment, { children: [
      needsUser.length > 0 ? /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("strong", { children: "\u9700\u8981\u7528\u6237\u5904\u7406" }),
        /* @__PURE__ */ jsx3("ul", { children: needsUser.map((b) => /* @__PURE__ */ jsxs3("li", { className: proofboard_default.blocker, children: [
          /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: b.code }),
          " ",
          b.message
        ] }, b.code + b.message)) })
      ] }) : null,
      retryable.length > 0 ? /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("strong", { children: "\u53EF\u81EA\u52A8\u91CD\u8BD5\uFF08\u91CD\u9A8C\u6700\u5C0F\u8BA1\u5212\uFF09" }),
        /* @__PURE__ */ jsx3("ul", { children: retryable.map((b) => /* @__PURE__ */ jsxs3("li", { className: proofboard_default.blocker, children: [
          /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: b.code }),
          " ",
          b.message
        ] }, b.code + b.message)) })
      ] }) : null,
      capability.length > 0 ? /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("strong", { children: "\u80FD\u529B/\u8BC1\u636E\u7F3A\u53E3" }),
        /* @__PURE__ */ jsx3("ul", { children: capability.map((b) => /* @__PURE__ */ jsxs3("li", { className: proofboard_default.blocker, children: [
          /* @__PURE__ */ jsx3("span", { className: proofboard_default.mono, children: b.code }),
          " ",
          b.message
        ] }, b.code + b.message)) })
      ] }) : null
    ] })
  ] });
}

// src/client/components/Proofboard.tsx
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function Proofboard(props) {
  const { state, data, loading } = props;
  return /* @__PURE__ */ jsxs4(
    "div",
    {
      className: proofboard_default.board,
      "data-cp-theme": props.theme ?? "light",
      "data-cp-status": state.status ?? "EMPTY",
      "data-cp-loading": loading ? "true" : "false",
      role: "region",
      "aria-label": "ChangeProof Proofboard",
      children: [
        /* @__PURE__ */ jsx4("span", { className: proofboard_default.announcement, role: "status", "aria-live": "polite", children: loading ? "\u6B63\u5728\u9A8C\u8BC1" : state.status ? `\u5F53\u524D\u72B6\u6001 ${state.status}` : "\u5C1A\u672A\u9A8C\u8BC1" }),
        /* @__PURE__ */ jsxs4(
          "header",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "space-between",
              flexWrap: "wrap"
            },
            children: [
              state.status ? /* @__PURE__ */ jsx4(StatusChip, { status: state.status, pendingHostConfirmation: state.pendingHostConfirmation, evidenceAgeIso: state.evidenceAgeIso }) : /* @__PURE__ */ jsx4("span", { className: proofboard_default.empty, children: "\u9996\u6B21\u4F7F\u7528\uFF1A\u70B9\u51FB Plan \u5206\u6790\u5F53\u524D\u53D8\u66F4" }),
              state.status === "STALE" && props.onReverify ? /* @__PURE__ */ jsx4("button", { type: "button", className: proofboard_default.button, onClick: props.onReverify, children: "\u91CD\u9A8C\uFF08\u6700\u5C0F\u8BA1\u5212\uFF09" }) : null
            ]
          }
        ),
        state.errorMessage ? /* @__PURE__ */ jsx4("p", { role: "alert", className: `${proofboard_default.chip} ${proofboard_default.severityError}`, children: state.errorMessage }) : null,
        loading ? /* @__PURE__ */ jsx4("p", { "aria-live": "polite", children: "\u5206\u6790\u4E2D\u2026\uFF08\u4E0D\u6267\u884C\u9879\u76EE\u4EE3\u7801\uFF09" }) : null,
        state.coverageSummary ? /* @__PURE__ */ jsxs4("p", { children: [
          "\u8986\u76D6 ",
          /* @__PURE__ */ jsxs4("strong", { children: [
            state.coverageSummary.covered,
            "/",
            state.coverageSummary.coverable
          ] }),
          " changed executable lines",
          state.coverageSummary.uncovered > 0 ? `\uFF0C\u672A\u8986\u76D6 ${state.coverageSummary.uncovered} \u884C` : ""
        ] }) : null,
        data ? /* @__PURE__ */ jsxs4("div", { className: proofboard_default.boardWide, children: [
          /* @__PURE__ */ jsx4(ChangeSummary, { files: data.changeSet.files, deletedLineRisk: data.changeSet.deletedLineRisk, mode: data.changeSet.mode }),
          /* @__PURE__ */ jsx4(ImpactList, { candidates: data.candidates, maxConfidence: data.maxConfidence }),
          /* @__PURE__ */ jsx4(CoverageTable, { files: data.coverageFiles, summary: data.coverageSummary }),
          /* @__PURE__ */ jsx4(EvidenceTimeline, { evidence: data.evidence })
        ] }) : /* @__PURE__ */ jsx4("p", { className: proofboard_default.empty, children: "\u65E0\u6570\u636E\uFF1A\u8FD0\u884C Plan \u6216 Verify \u540E\u663E\u793A\u53D8\u66F4\u3001\u5019\u9009\u6D4B\u8BD5\u3001\u8986\u76D6\u4E0E\u8BC1\u636E\u3002" }),
        /* @__PURE__ */ jsx4(BlockerList, { blockers: state.blockers })
      ]
    }
  );
}

// src/client/components/VerifyDock.tsx
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function VerifyDock(props) {
  return /* @__PURE__ */ jsxs5("div", { className: proofboard_default.dock, role: "toolbar", "aria-label": "ChangeProof \u64CD\u4F5C", children: [
    /* @__PURE__ */ jsx5("button", { type: "button", className: proofboard_default.button, onClick: props.onPlan, disabled: props.running, children: "Plan\uFF08\u4EC5\u5206\u6790\uFF09" }),
    /* @__PURE__ */ jsx5("button", { type: "button", className: `${proofboard_default.button} ${proofboard_default.buttonPrimary}`, onClick: props.onVerify, disabled: props.running, children: props.running ? "\u6267\u884C\u4E2D\u2026" : "Verify\uFF08\u6267\u884C\u6D4B\u8BD5\uFF0C\u9700\u5BA1\u6279\uFF09" }),
    props.running && props.onCancel ? /* @__PURE__ */ jsx5("button", { type: "button", className: proofboard_default.button, onClick: props.onCancel, children: "\u53D6\u6D88\uFF08\u7EC8\u6B62\u8FDB\u7A0B\u6811\uFF09" }) : null,
    props.unverifiedHint ? /* @__PURE__ */ jsx5("span", { "aria-live": "polite", children: "\u5F53\u524D\u6539\u52A8\u5C1A\u672A\u9A8C\u8BC1" }) : null
  ] });
}
function SettingsSection(props) {
  return /* @__PURE__ */ jsxs5("section", { className: proofboard_default.section, "aria-labelledby": "cp-settings-title", children: [
    /* @__PURE__ */ jsx5("h3", { id: "cp-settings-title", className: proofboard_default.sectionTitle, children: "ChangeProof \u8BBE\u7F6E" }),
    /* @__PURE__ */ jsxs5("p", { children: [
      "\u914D\u7F6E\u6765\u6E90: ",
      /* @__PURE__ */ jsx5("span", { className: proofboard_default.mono, children: props.configSource }),
      "\uFF08\u63D2\u4EF6\u4E0D\u4FEE\u6539\u7528\u6237\u914D\u7F6E\uFF09"
    ] }),
    /* @__PURE__ */ jsxs5("table", { className: proofboard_default.table, children: [
      /* @__PURE__ */ jsx5("thead", { children: /* @__PURE__ */ jsxs5("tr", { children: [
        /* @__PURE__ */ jsx5("th", { scope: "col", children: "Package" }),
        /* @__PURE__ */ jsx5("th", { scope: "col", children: "Root" }),
        /* @__PURE__ */ jsx5("th", { scope: "col", children: "Adapter" })
      ] }) }),
      /* @__PURE__ */ jsx5("tbody", { children: props.packages.map((p) => /* @__PURE__ */ jsxs5("tr", { children: [
        /* @__PURE__ */ jsx5("td", { children: p.id }),
        /* @__PURE__ */ jsx5("td", { className: proofboard_default.mono, children: p.root || "." }),
        /* @__PURE__ */ jsx5("td", { className: proofboard_default.mono, children: p.adapter })
      ] }, p.id)) })
    ] }),
    /* @__PURE__ */ jsxs5("p", { children: [
      "changedLines \u9608\u503C: ",
      /* @__PURE__ */ jsxs5("span", { className: proofboard_default.mono, children: [
        (props.thresholds.changedLines * 100).toFixed(0),
        "%"
      ] }),
      " \xB7 \u6700\u4F4E impact \u7F6E\u4FE1\u5EA6:",
      " ",
      /* @__PURE__ */ jsx5("span", { className: proofboard_default.mono, children: props.thresholds.minimumImpactConfidence })
    ] }),
    props.exclude.length > 0 ? /* @__PURE__ */ jsxs5("p", { children: [
      "\u6392\u9664\u89C4\u5219\uFF08UI \u4E2D\u59CB\u7EC8\u5C55\u793A\uFF0C\u4E0D\u9690\u8EAB\uFF09: ",
      props.exclude.join(", ")
    ] }) : null
  ] });
}

// src/client/index.tsx
import { jsx as jsx6 } from "react/jsx-runtime";
function createChangeproofClient(shell, workspaceRoot) {
  let state = INITIAL_CLIENT_STATE;
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const l of listeners) l();
  };
  const dispatch = (event) => {
    state = clientReducer(state, event);
    notify();
  };
  const unsubTools = shell.onToolResult((raw) => {
    const kind = raw?.kind ?? "";
    dispatch({ type: kind.startsWith("changeproof_") ? "tool-result" : "mutation-observed", raw, toolId: kind, at: (/* @__PURE__ */ new Date()).toISOString() });
  });
  const disposers = [
    unsubTools,
    shell.mountHeaderAction({ render: () => /* @__PURE__ */ jsx6(StatusChip, { status: state.status ?? "UNVERIFIED", compact: true, pendingHostConfirmation: state.pendingHostConfirmation }) }),
    shell.mountInputDock({
      render: () => /* @__PURE__ */ jsx6(
        VerifyDock,
        {
          unverifiedHint: state.status === null || state.status === "UNVERIFIED",
          onPlan: () => void shell.invokeTool("changeproof_plan", { workspace: workspaceRoot }),
          onVerify: () => void shell.invokeTool("changeproof_verify", { workspace: workspaceRoot, approvalIntent: "approve" })
        }
      )
    }),
    shell.mountDetails({ render: (data) => /* @__PURE__ */ jsx6(Proofboard, { state, data }) }),
    shell.mountSettings({
      render: (cfg) => /* @__PURE__ */ jsx6(SettingsSection, { ...cfg })
    })
  ];
  return {
    getState: () => state,
    dispose() {
      for (const d of disposers.splice(0)) d();
      listeners.clear();
    }
  };
}
export {
  INITIAL_CLIENT_STATE,
  clientReducer,
  createChangeproofClient
};
//# sourceMappingURL=index.mjs.map
