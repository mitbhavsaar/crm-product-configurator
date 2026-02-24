/** @odoo-module */

import { Component, useState, onMounted } from "@odoo/owl";
import { formatCurrency } from "@web/core/currency";
import { rpc } from "@web/core/network/rpc";

export class ProductTemplateAttributeLine extends Component {
    static template = "crmProductConfigurator.ptal";

    static props = {
        productTmplId: Number,
        id: Number,
        attribute: {
            type: Object,
            shape: {
                id: Number,
                name: String,
                display_type: {
                    type: String,
                    validate: t =>
                        ["color", "multi", "pills", "radio", "select", "file_upload", "m2o", "strictly_numeric"].includes(t),
                },
                m2o_model_id: { type: [Boolean, Object], optional: true },
                m2o_values: { type: Array, element: Object, optional: true },
                pair_with_previous: { type: Boolean, optional: true }, //  NEW
                is_width_check: { type: Boolean, optional: true }, //  NEW
                m2o_model_technical_name: { type: [String, Boolean], optional: true }, //  NEW
                is_gelcoat_required_flag: { type: Boolean, optional: true }, //  NEW
                is_quantity: { type: Boolean, optional: true }, //  NEW - Fix for OwlError
            },
        },
        attribute_values: {
            type: Array,
            element: {
                type: Object,
                shape: {
                    id: Number,
                    name: String,
                    html_color: [Boolean, String],
                    image: [Boolean, String],
                    is_custom: Boolean,
                    excluded: { type: Boolean, optional: true },
                    m2o_res_id: { optional: true },
                    required_file: { type: Boolean, optional: true }, // NEW: Track if file is required
                    is_opaque: { type: Boolean, optional: true },     // NEW
                    is_translucent: { type: Boolean, optional: true }, // NEW
                },
            },
        },
        selected_attribute_value_ids: { type: Array, element: Number },
        create_variant: {
            type: String,
            validate: t => ["always", "dynamic", "no_variant"].includes(t),
        },
        customValue: { type: [{ value: false }, String], optional: true },
        m2o_values: { type: Array, element: Object, optional: true },
    };

    setup() {
        // Initialize reactive multiple file state
        this.fileState = useState({
            files: [], // List of {name, data}
        });

        // Initialize reactive multiple conditional file state
        this.conditionalFileState = useState({
            files: [], // List of {name, data}
        });

        // Reactive M2O state
        this.m2oState = useState({
            selectedId: null,
        });

        // Reactive warning state
        this.warningState = useState({
            numeric: "",
        });

        onMounted(() => {
            // ✅ Contextual M2O pre-filling: Only use data for the SELECTED value
            if (this.props.attribute.display_type === "m2o") {
                const selectedPtav = this.props.attribute_values.find(v =>
                    this.props.selected_attribute_value_ids.includes(v.id) &&
                    v.m2o_res_id && v.m2o_res_id !== 0
                );
                if (selectedPtav) {
                    const resId = Array.isArray(selectedPtav.m2o_res_id) ?
                        selectedPtav.m2o_res_id[0] : selectedPtav.m2o_res_id;
                    if (resId) {
                        this.m2oState.selectedId = resId;
                        console.log(`✅ Pre-filled M2O for ${this.props.attribute.name}: ${resId}`);
                    }
                }
            }

            //  FIX: Default single-value selection logic
            if (
                this.props.attribute_values.length === 1 &&
                this.props.selected_attribute_value_ids.length === 0 &&
                this.props.attribute.display_type !== "m2o"
            ) {
                this.updateSelectedPTAV({
                    target: { value: this.props.attribute_values[0].id.toString() },
                });
            }
        });
    }

    // -----------------------------
    // DEFAULT PTAV UPDATE
    // -----------------------------
    updateSelectedPTAV(event) {
        //  FIX: Clear conditional files when switching away from required_file option
        // Check if we're switching from a value with required_file to one without
        const newValueId = parseInt(event.target.value);
        const newPTAV = this.props.attribute_values.find(v => v.id === newValueId);

        // If new selection doesn't require file, clear the conditional file state
        if (newPTAV && !newPTAV.required_file && this.conditionalFileState.files.length > 0) {
            console.log("🧹 Clearing conditional files - switching to option without required_file");
            this.conditionalFileState.files = [];

            // Notify parent dialog that conditional files are cleared
            if (this.env.updateConditionalFileUpload) {
                this.env.updateConditionalFileUpload(
                    this.props.productTmplId,
                    this.props.id,
                    null
                );
            }
        }

        this.env.updateProductTemplateSelectedPTAV(
            this.props.productTmplId,
            this.props.id,
            event.target.value,
            this.props.attribute.display_type === "multi"
        );
    }

    updateCustomValue(event) {
        this.env.updatePTAVCustomValue(
            this.props.productTmplId,
            this.props.selected_attribute_value_ids[0],
            event.target.value
        );
    }

    // -----------------------------
    // TEMPLATE SELECTION
    // -----------------------------
    getPTAVTemplate() {
        switch (this.props.attribute.display_type) {
            case "color":
                return "crmProductConfigurator.ptav-color";
            case "multi":
                return "crmProductConfigurator.ptav-multi";
            case "pills":
                return "crmProductConfigurator.ptav-pills";
            case "radio":
                return "crmProductConfigurator.ptav-radio";
            case "select":
                return "crmProductConfigurator.ptav-select";
            case "file_upload":
                return "entrivis_file_upload.ptav-file-upload";
            case "m2o":
                return "crmProductConfigurator.ptav-m2o";
            case "strictly_numeric":
                return "crmProductConfigurator.ptav-strictly-numeric";
        }
    }

    getPTAVSelectName(ptav) {
        return ptav.name;
    }

    isSelectedPTAVCustom() {
        return this.props.attribute_values.find(
            ptav => this.props.selected_attribute_value_ids.includes(ptav.id)
        )?.is_custom;
    }

    hasPTAVCustom() {
        return this.props.attribute_values.some(ptav => ptav.is_custom);
    }

    isSingleValueReadOnly() {
        return (
            this.props.attribute_values.length === 1 &&
            !this.hasPTAVCustom()
        );
    }

    // -----------------------------
    // FILE UPLOAD LOGIC - ALWAYS FRESH
    // -----------------------------
    getSelectedPTAV() {
        return this.props.attribute_values.find(v =>
            this.props.selected_attribute_value_ids.includes(v.id)
        );
    }

    // Return list of files from state
    getFiles() {
        return this.fileState.files || [];
    }

    /**
     * Upload one or more files
     */
    async uploadFile(ev) {
        const files = Array.from(ev.target.files);
        if (!files.length) return;

        const uploadPromises = files.map(file => {
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => {
                    const base64 = e.target.result.split(",")[1];
                    resolve({ name: file.name, data: base64 });
                };
                reader.readAsDataURL(file);
            });
        });

        const newFiles = await Promise.all(uploadPromises);

        // Append to existing files
        this.fileState.files.push(...newFiles);

        // Notify parent dialog
        if (this.env.updateFileUpload) {
            this.env.updateFileUpload(
                this.props.productTmplId,
                this.props.id,
                this.fileState.files
            );
        }
    }

    /**
     * Remove a specific file by index
     */
    removeUploadedFile(index) {
        this.fileState.files.splice(index, 1);

        // notify dialog
        if (this.env.updateFileUpload) {
            this.env.updateFileUpload(
                this.props.productTmplId,
                this.props.id,
                this.fileState.files.length > 0 ? this.fileState.files : null
            );
        }
    }

    // -----------------------------
    // STRICTLY NUMERIC VALIDATION
    // -----------------------------
    validateNumeric(event) {
        const value = event.target.value;
        const isValid = /^[0-9]*\.?[0-9]*$/.test(value);

        if (!isValid) {
            this.warningState.numeric = "Numeric Values Only !";
        } else {
            this.warningState.numeric = "";
        }

        // restrict input visually - allow digits and decimal point
        event.target.value = value.replace(/[^0-9.]/g, "");

        // save the cleaned numeric value
        this.updateCustomValue(event);
    }


    async updateSelectedM2O(ev) {
        const value = ev.target.value;

        // empty selection
        if (value === "") {
            this.m2oState.selectedId = null;
            if (this.env.updateM2OValue) {
                this.env.updateM2OValue(
                    this.props.productTmplId,
                    this.props.id,
                    null
                );
            }

            //  NEW: Clear PDF if this was the profile attribute
            const modelName = this.props.attribute.m2o_model_technical_name ||
                (Array.isArray(this.props.attribute.m2o_model_id) ? false : this.props.attribute.m2o_model_id?.model);
            if (modelName === "profile.name" && this.env.updateProfilePdf) {
                this.env.updateProfilePdf(null);
            }
            return;
        }

        const resId = parseInt(value);
        this.m2oState.selectedId = resId;

        // normal M2O propagate
        if (this.env.updateM2OValue) {
            this.env.updateM2OValue(
                this.props.productTmplId,
                this.props.id,
                resId
            );
        }

        const modelName = this.props.attribute.m2o_model_technical_name ||
            (Array.isArray(this.props.attribute.m2o_model_id) ? false : this.props.attribute.m2o_model_id?.model);

        // only profile → autofill width and side panel PDF
        if (modelName === "profile.name") {
            console.log("🔍 Profile selected, fetching data...");

            //  NEW: Fetch PDF for side panel
            if (this.env.updateProfilePdf) {
                this.env.updateProfilePdf(resId);
            }

            try {
                const result = await rpc("/web/dataset/call_kw/profile.name/read", {
                    model: "profile.name",
                    method: "read",
                    args: [[resId], ["width"]],
                    kwargs: {},
                });

                const width = result?.length ? result[0].width : false;
                console.log(" Width from profile:", width);

                if (width || width === 0) {
                    if (this.env.autoFillWidthFromM2O) {
                        this.env.autoFillWidthFromM2O(
                            this.props.productTmplId,
                            String(width)
                        );
                    }
                }
            } catch (e) {
                console.error(" Failed to fetch profile width:", e);
            }
        }
    }


    getSelectedM2OId() {
        //  FIX: Always use component state, never from PTAV
        return this.m2oState.selectedId;
    }

    /**
     *  NEW: Check if this is a required Gel-coat attribute and user HASN'T selected anything.
     * This is used for real-time red warning.
     */
    get isMissingRequiredGelCoat() {
        if (!this.props.attribute.is_gelcoat_required_flag) return false;
        if (!this.env.isGelCoatRequired || !this.env.isGelCoatRequired()) return false;
        const selectedId = this.getSelectedM2OId();
        return !selectedId || selectedId === "";
    }

    // -----------------------------
    // CONDITIONAL FILE UPLOAD LOGIC
    // -----------------------------

    /**
     * Check if conditional file upload should be shown
     * Only show if:
     * 1. Display type is radio or select
     * 2. A value is selected
     * 3. The selected value has required_file = true
     */
    shouldShowConditionalFileUpload() {
        // Only for radio/select display types
        if (!['radio', 'select'].includes(this.props.attribute.display_type)) {
            return false;
        }

        // Get selected value
        const selectedPTAV = this.props.attribute_values.find(v =>
            this.props.selected_attribute_value_ids.includes(v.id)
        );

        console.log("🔍 Checking conditional file upload:", {
            attribute: this.props.attribute.name,
            display_type: this.props.attribute.display_type,
            selected_ids: this.props.selected_attribute_value_ids,
            selectedPTAV: selectedPTAV,
            required_file: selectedPTAV ? selectedPTAV.required_file : 'N/A'
        });

        // Show if selected value has required_file flag
        return selectedPTAV && selectedPTAV.required_file;
    }

    /**
     * Get conditional files
     */
    getConditionalFiles() {
        return this.conditionalFileState.files || [];
    }

    /**
     * Upload one or more conditional files (BOQ)
     */
    async uploadConditionalFile(ev) {
        const files = Array.from(ev.target.files);
        if (!files.length) return;

        const uploadPromises = files.map(file => {
            return new Promise(resolve => {
                const reader = new FileReader();
                reader.onload = e => {
                    const base64 = e.target.result.split(",")[1];
                    resolve({ name: file.name, data: base64 });
                };
                reader.readAsDataURL(file);
            });
        });

        const newFiles = await Promise.all(uploadPromises);

        // Append to existing files
        this.conditionalFileState.files.push(...newFiles);

        // Notify parent dialog
        if (this.env.updateConditionalFileUpload) {
            this.env.updateConditionalFileUpload(
                this.props.productTmplId,
                this.props.id,
                this.conditionalFileState.files
            );
        }
    }

    /**
     * Remove conditional file
     */
    removeConditionalFile(index) {
        this.conditionalFileState.files.splice(index, 1);

        // Notify dialog
        if (this.env.updateConditionalFileUpload) {
            this.env.updateConditionalFileUpload(
                this.props.productTmplId,
                this.props.id,
                this.conditionalFileState.files.length > 0 ? this.conditionalFileState.files : null
            );
        }
    }
}