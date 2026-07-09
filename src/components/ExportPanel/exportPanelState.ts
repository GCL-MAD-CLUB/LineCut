import type { ExportOptions } from "../../types";
import { createPanelState } from "../../panelState";

interface ExportPanelState {
  exportOptions: ExportOptions;
  updateExportOptions: (options: Partial<ExportOptions>) => void;
}

function defaultExportOptions(): ExportOptions {
  return {
    head_padding_ms: 300,
    tail_padding_ms: 500,
    merge_gap_ms: 800,
    mode: "precise_encode",
    layout: "individual",
    output_dir: "",
    output_dir_explicit: false,
    export_name_rule: "source_time_range",
    dialogue_line_indexes: [],
  };
}

export const useExportPanelState = createPanelState<ExportPanelState>(() => (set) => ({
  exportOptions: defaultExportOptions(),
  updateExportOptions: (options) =>
    set((state) => ({
      exportOptions: {
        ...state.exportOptions,
        ...options,
      },
    })),
}));
