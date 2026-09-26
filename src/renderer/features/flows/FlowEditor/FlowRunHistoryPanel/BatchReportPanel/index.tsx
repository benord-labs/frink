/**
 * Legacy folder: the BatchReportPanel component (the rail's old "Batch" sub-tab) was
 * superseded by the Runs tab's BatchMonitor pane. The folder keeps its name because the
 * import-wall grandfather baseline is path-keyed; it now only hosts the shared batch-plan
 * pieces (BatchPlanCanvas, TemplatePicker, DirtyNavAlertDialog, stage-status styles).
 */

export { BatchPlanCanvas } from './BatchPlanCanvas';
export { LoadTemplatePicker, SaveTemplatePopover } from './TemplatePicker';
