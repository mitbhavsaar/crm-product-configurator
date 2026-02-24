/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onWillStart, useState, useSubEnv, useEffect } from "@odoo/owl";
import { Dialog } from '@web/core/dialog/dialog';
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { CrmProductList } from "../product_list/product_list";
import { rpc } from "@web/core/network/rpc";

export class crmProductConfiguratorDialog extends Component {
    static components = { Dialog, CrmProductList };
    static template = 'crm_product_configurator.dialog';
    static props = {
        productTemplateId: Number,
        ptavIds: { type: Array, element: Number },
        customAttributeValues: {
            type: Array,
            element: Object,
            shape: {
                ptavId: Number,
                value: String,
            }
        },
        quantity: Number,
        productUOMId: { type: Number, optional: true },
        companyId: { type: Number, optional: true },
        currencyId: { type: Number, optional: true },
        crmLeadId: Number,
        materialLineId: { type: [Number, Boolean], optional: true },
        edit: { type: Boolean, optional: true },
        save: Function,
        discard: Function,
        close: Function,
    };

    static defaultProps = {
        edit: false,
    }

    setup() {
        this.optionalProductsTitle = _t("Add optional products");
        this.title = _t("Configure your product");
        this.rpc = rpc;
        this.state = useState({
            products: [],
            optionalProducts: [],
            fileUploads: {}, // Store lists of {name, data} per product_ptal
            m2oValues: {},   // Store M2O selections per product
            conditionalFileUploads: {}, // Store lists of {name, data} per product_ptal
            profilePdfUrl: null, //  NEW: Store URL of selected profile's PDF
            pdfZoom: 1.0,        //  NEW: Current zoom level
            pdfRotation: 0,      //  NEW: Manual rotation angle
            isPdfLandscape: false, // NEW: Track if PDF was auto-detected as landscape
            dimensionRows: {},   // { [tmplId]: [{ length: 0, width: 0, lUomId: null, wUomId: null }] }
            lengthUoms: [],
            showConfirmSaveWarning: false, // NEW: Soft validation for Raisin/Gelcoat
        });

        useSubEnv({
            mainProductTmplId: this.props.productTemplateId,
            currencyId: this.props.currencyId,
            addProduct: this._addProduct.bind(this),
            removeProduct: this._removeProduct.bind(this),
            setQuantity: this._setQuantity.bind(this),
            updateProductTemplateSelectedPTAV: this._updateProductTemplateSelectedPTAV.bind(this),
            updatePTAVCustomValue: this._updatePTAVCustomValue.bind(this),
            updateFileUpload: this._updateFileUpload.bind(this),        //  NEW
            updateM2OValue: this._updateM2OValue.bind(this),            //  NEW
            updateConditionalFileUpload: this._updateConditionalFileUpload.bind(this), // NEW
            updateProfilePdf: this.updateProfilePdf.bind(this),        //  NEW
            isPossibleCombination: this._isPossibleCombination,
            //  NEW: expose callback for auto-fill width
            autoFillWidthFromM2O: this.autoFillWidthFromM2O.bind(this),
            //  NEW: exposed for dimension rows
            updateDimensionRow: this._updateDimensionRow.bind(this),
            addDimensionRow: this._addDimensionRow.bind(this),
            removeDimensionRow: this._removeDimensionRow.bind(this),
            getDimensionRows: (tmplId) => this.state.dimensionRows[tmplId] || [],
            getUomOptions: this._getUomOptions.bind(this),
            //  NEW: helper to check if Gel-coat is mandatory in real-time
            isGelCoatRequired: () => {
                const mainProduct = this.state.products[0];
                if (!mainProduct || !mainProduct.attribute_lines) return false;
                const gelCoatReqPTAL = mainProduct.attribute_lines.find(ptal => {
                    const name = ptal.attribute?.name?.toLowerCase() || '';
                    return name.includes('gel coat req') || name.includes('gelcoat req');
                });
                if (!gelCoatReqPTAL) return false;
                const selectedPtavs = gelCoatReqPTAL.attribute_values.filter(v =>
                    gelCoatReqPTAL.selected_attribute_value_ids.includes(v.id)
                );
                return selectedPtavs.some(v => v.name?.toLowerCase() === 'yes');
            },
        });

        useEffect(() => { }, () => [this.state.products]);

        onWillStart(async () => {
            const { products, optional_products } = await this._loadData(this.props.edit);
            this.state.products = products;
            this.state.optionalProducts = optional_products;
            this._setDefaultThickness();

            for (const customValue of this.props.customAttributeValues) {
                this._updatePTAVCustomValue(
                    this.env.mainProductTmplId,
                    customValue.ptavId,
                    customValue.value
                );
            }

            if (this.state.products.length > 0) {
                this._checkExclusions(this.state.products[0]);

                // ✅ Pre-fill M2O values from provided state (if any)
                // This ensures we don't pick up leaked values from shared PTAVs
                for (const product of this.state.products) {
                    for (const ptal of product.attribute_lines || []) {
                        if (ptal.attribute.display_type === 'm2o') {
                            // Only pre-fill if we have an ID from the backend specifically for this record
                            // Currently, ptav_ids passed from crm_product_field.js should be the source of truth
                            const selectedPtav = ptal.attribute_values.find(v =>
                                ptal.selected_attribute_value_ids.includes(v.id) && v.m2o_res_id
                            );
                            if (selectedPtav) {
                                const resId = Array.isArray(selectedPtav.m2o_res_id) ?
                                    selectedPtav.m2o_res_id[0] : selectedPtav.m2o_res_id;
                                if (resId) {
                                    this._updateM2OValue(product.product_tmpl_id, ptal.id, resId);
                                    console.log(`✅ Pre-filled M2O from record data: ${ptal.attribute.name} -> ${resId}`);
                                }
                            }
                        }
                    }
                }
            }

            //  NEW: Fetch is_width_check, pair_with_previous manually since backend might not send it
            await this._enrichAttributesWithMetadata();

            // Initialize dimension rows for products that have Length and Width
            for (const product of [...this.state.products, ...this.state.optionalProducts]) {
                if (this._hasDimensions(product)) {
                    if (!this.state.dimensionRows[product.product_tmpl_id]) {
                        const lUomPtal = product.attribute_lines.find(l => l.attribute.name.toLowerCase().includes('length uom'));
                        const wUomPtal = product.attribute_lines.find(l => l.attribute.name.toLowerCase().includes('width uom'));
                        const qUomPtal = product.attribute_lines.find(l => l.attribute.name.toLowerCase().includes('quantity uom') || l.attribute.name.toLowerCase().includes('qty uom'));

                        this.state.dimensionRows[product.product_tmpl_id] = [{
                            length: "",
                            width: "",
                            qty: "1",
                            lUomId: lUomPtal?.selected_attribute_value_ids?.[0] || lUomPtal?.attribute_values?.[0]?.id || false,
                            wUomId: wUomPtal?.selected_attribute_value_ids?.[0] || wUomPtal?.attribute_values?.[0]?.id || false,
                            qUomId: qUomPtal?.selected_attribute_value_ids?.[0] || qUomPtal?.attribute_values?.[0]?.id || false,
                        }];
                    }
                }
            }
        });
    }

    _hasDimensions(product) {
        return product.attribute_lines?.some(l => l.attribute.name.toLowerCase() === 'length') &&
            product.attribute_lines?.some(l => l.attribute.name.toLowerCase() === 'width');
    }

    _getUomOptions(productTmplId, type) {
        const product = this._findProduct(productTmplId);
        if (!product || !product.attribute_lines) return [];
        const ptal = product.attribute_lines.find(l => l.attribute.name.toLowerCase().includes(`${type} uom`));
        return ptal?.attribute_values || [];
    }

    _syncFirstDimensionToAttributes(product) {
        const rows = this.state.dimensionRows[product.product_tmpl_id];
        if (!rows || rows.length === 0) return;

        const firstRow = rows[0];
        const lines = product.attribute_lines || [];

        // 1. Length
        const lengthPtal = lines.find(l => l.attribute.name.toLowerCase() === 'length');
        if (lengthPtal) {
            lengthPtal.customValue = firstRow.length.toString();
        }

        // 2. Width
        const widthPtal = lines.find(l => l.attribute.name.toLowerCase() === 'width');
        if (widthPtal) {
            widthPtal.customValue = firstRow.width.toString();
        }

        // 3. Length UOM
        const lUomPtal = lines.find(l => l.attribute.name.toLowerCase().includes('length uom'));
        if (lUomPtal && firstRow.lUomId) {
            lUomPtal.selected_attribute_value_ids = [firstRow.lUomId];
        }

        // 4. Width UOM
        const wUomPtal = lines.find(l => l.attribute.name.toLowerCase().includes('width uom'));
        if (wUomPtal && firstRow.wUomId) {
            wUomPtal.selected_attribute_value_ids = [firstRow.wUomId];
        }
    }

    //  NEW: Helper to fetch metadata (is_width_check, is_opaque, is_translucent, etc.)
    async _enrichAttributesWithMetadata() {
        const allProducts = [...this.state.products, ...this.state.optionalProducts];
        const attributeIds = new Set();
        const ptavIds = new Set(); // Collect Attribute Value IDs

        // 1. Collect all Attributes and Attribute Values (and identify M2O values)
        const m2oValuesMap = {}; // { 'raisin.type': [1, 2, 3], 'gel.coat': [4, 5] }

        for (const product of allProducts) {
            for (const ptal of product.attribute_lines || []) {
                if (ptal.attribute && ptal.attribute.id) {
                    attributeIds.add(ptal.attribute.id);
                }
                if (ptal.attribute_values) {
                    for (const ptav of ptal.attribute_values) {
                        ptavIds.add(ptav.id);

                        // Check if it's an M2O value and collect the res_id
                        if (ptav.m2o_res_id) {
                            // m2o_res_id can be [id, name] or just id
                            const resId = Array.isArray(ptav.m2o_res_id) ? ptav.m2o_res_id[0] : ptav.m2o_res_id;
                            const model = ptal.attribute.m2o_model_technical_name; // We need this from attribute metadata first!

                            // We can't know the model yet, so we'll store mapping of ptav_id -> res_id 
                            // and process it AFTER fetching attribute metadata (step 2)
                        }
                    }
                }
            }
        }
        if (attributeIds.size === 0) return;

        try {
            // 2. Fetch Attribute Metadata
            const attributesData = await this.rpc("/web/dataset/call_kw/product.attribute/read", {
                model: "product.attribute",
                method: "read",
                args: [[...attributeIds], ["is_width_check", "m2o_model_id", "pair_with_previous", "is_quantity", "is_gelcoat_required_flag"]],
                kwargs: {},
            });

            // Map Attributes to Metadata
            const attributeMap = {};
            const irModelIds = new Set();
            const attrToIrModelId = {};

            for (const attr of attributesData) {
                // Collect IR Model IDs to resolve model names
                if (attr.m2o_model_id) {
                    const irModelId = Array.isArray(attr.m2o_model_id) ? attr.m2o_model_id[0] : attr.m2o_model_id;
                    if (irModelId) {
                        irModelIds.add(irModelId);
                        attrToIrModelId[attr.id] = irModelId;
                    }
                }
            }

            // Fetch model names from ir.model
            const irModelMap = {};
            if (irModelIds.size > 0) {
                const irModelsData = await this.rpc("/web/dataset/call_kw/ir.model/read", {
                    model: "ir.model",
                    method: "read",
                    args: [[...irModelIds], ["model"]],
                    kwargs: {},
                });
                for (const m of irModelsData) {
                    irModelMap[m.id] = m.model;
                }
            }

            // Finalize Attribute Map
            for (const attr of attributesData) {
                const modelName = attrToIrModelId[attr.id] ? irModelMap[attrToIrModelId[attr.id]] : false;
                attributeMap[attr.id] = {
                    is_width_check: attr.is_width_check,
                    m2o_model_technical_name: modelName,
                    pair_with_previous: attr.pair_with_previous,
                    is_quantity: attr.is_quantity,
                    is_gelcoat_required_flag: attr.is_gelcoat_required_flag,
                };
            }

            // 3. Fetch Attribute Value Metadata (Standard Fields)
            let valuesData = [];
            if (ptavIds.size > 0) {
                valuesData = await this.rpc("/web/dataset/call_kw/product.attribute.value/read", {
                    model: "product.attribute.value",
                    method: "read",
                    args: [[...ptavIds], ["is_opaque", "is_translucent"]], // Fetch m2o_res_id here if needed
                    kwargs: {},
                });
            }

            const valueMap = {};
            // Initialize with standard flags
            for (const val of valuesData) {
                valueMap[val.id] = {
                    is_opaque: val.is_opaque,
                    is_translucent: val.is_translucent
                };
            }

            // 4. Fetch Flags from LINKED M2O Records (Raisin Type, Gel Coat)
            // Identify which records to fetch based on attribute model
            const m2oFetches = {}; // { 'raisin.type': [id1, id2], 'gel.coat': [id3] }
            const ptavToM2oMap = {}; // { ptav_id: { model: 'raisin.type', res_id: 123 } }

            for (const product of allProducts) {
                for (const ptal of product.attribute_lines || []) {
                    const modelName = attributeMap[ptal.attribute.id]?.m2o_model_technical_name;
                    if (modelName && (modelName === 'raisin.type' || modelName === 'gel.coat')) {
                        // 1. Collect from attribute_values (selected PTAVs)
                        for (const ptav of ptal.attribute_values) {
                            const resId = Array.isArray(ptav.m2o_res_id) ? ptav.m2o_res_id[0] : ptav.m2o_res_id;
                            if (resId) {
                                if (!m2oFetches[modelName]) m2oFetches[modelName] = new Set();
                                m2oFetches[modelName].add(resId);
                                ptavToM2oMap[ptav.id] = { model: modelName, resId: resId };
                            }
                        }
                        // 2. Collect from attribute.m2o_values (dropdown options)
                        if (ptal.attribute.m2o_values) {
                            for (const rec of ptal.attribute.m2o_values) {
                                if (rec.id) {
                                    if (!m2oFetches[modelName]) m2oFetches[modelName] = new Set();
                                    m2oFetches[modelName].add(rec.id);
                                }
                            }
                        }
                    }
                }
            }

            // Execute RPC for each M2O model
            const m2oFlagsMap = {}; // { 'raisin.type_123': { is_opaque: true, ... } }
            for (const [model, idsSet] of Object.entries(m2oFetches)) {
                if (idsSet.size > 0) {
                    try {
                        const records = await this.rpc(`/web/dataset/call_kw/${model}/read`, {
                            model: model,
                            method: "read",
                            args: [[...idsSet], ["is_opaque", "is_translucent"]],
                            kwargs: {},
                        });
                        for (const r of records) {
                            m2oFlagsMap[`${model}_${r.id}`] = {
                                is_opaque: r.is_opaque,
                                is_translucent: r.is_translucent
                            };
                        }
                    } catch (e) {
                        console.warn(`Failed to fetch flags for ${model}`, e);
                    }
                }
            }

            // Update state
            for (const product of allProducts) {
                for (const ptal of product.attribute_lines || []) {
                    // Update Attribute Flags
                    if (ptal.attribute && attributeMap[ptal.attribute.id]) {
                        Object.assign(ptal.attribute, attributeMap[ptal.attribute.id]);
                    }
                    // Update Attribute Value Flags
                    if (ptal.attribute_values) {
                        for (const ptav of ptal.attribute_values) {
                            // First apply standard PA flags (fallback)
                            if (valueMap[ptav.id]) {
                                Object.assign(ptav, valueMap[ptav.id]);
                            }

                            // OVERWRITE with M2O specific flags if available
                            if (ptavToM2oMap[ptav.id]) {
                                const { model, resId } = ptavToM2oMap[ptav.id];
                                const flags = m2oFlagsMap[`${model}_${resId}`];
                                if (flags) {
                                    ptav.is_opaque = flags.is_opaque;
                                    ptav.is_translucent = flags.is_translucent;
                                }
                            }
                        }
                    }
                    // NEW: Update M2O Values Flags (dropdown options)
                    if (ptal.attribute.m2o_values) {
                        const modelName = attributeMap[ptal.attribute.id]?.m2o_model_technical_name;
                        for (const rec of ptal.attribute.m2o_values) {
                            const flags = m2oFlagsMap[`${modelName}_${rec.id}`];
                            if (flags) {
                                rec.is_opaque = flags.is_opaque;
                                rec.is_translucent = flags.is_translucent;
                            }
                        }
                    }
                }
            }
            console.log(" Enriched attributes & values with M2O flags:", { attributeMap, valueMap, m2oFlagsMap });
        } catch (err) {
            console.error(" Failed to fetch attribute details:", err);
        }
    }

    autoFillWidthFromM2O(productTmplId, widthValue) {
        const product = this.state.products.find(p => p.product_tmpl_id === productTmplId);
        if (!product) return;

        const widthPTAL = product.attribute_lines.find(ptal =>
            ptal.attribute.name.toLowerCase() === "width"
        );
        if (!widthPTAL) return;

        const customPTAV = widthPTAL.attribute_values.find(v => v.is_custom);
        if (customPTAV) {
            widthPTAL.selected_attribute_value_ids = [customPTAV.id];
        }

        widthPTAL.customValue = widthValue;

        //  NEW: Update dimension rows for the custom UI
        if (this.state.dimensionRows[productTmplId] && this.state.dimensionRows[productTmplId][0]) {
            this.state.dimensionRows[productTmplId][0].width = widthValue === "" ? "" : (parseFloat(widthValue) || 0);
            this.state.dimensionRows = { ...this.state.dimensionRows };
        }

        //  UI Refresh
        this.state.products = [...this.state.products];
    }

    _addDimensionRow(productTmplId) {
        if (!this.state.dimensionRows[productTmplId]) {
            this.state.dimensionRows[productTmplId] = [];
        }

        const rows = this.state.dimensionRows[productTmplId];
        const previousRow = rows.length > 0 ? rows[rows.length - 1] : null;

        //  AUTO-FILL LOGIC: Copy Width and UOMs from previous row, keep Length as 0
        this.state.dimensionRows[productTmplId].push({
            length: "",
            width: previousRow ? previousRow.width : "",
            qty: "1",
            lUomId: previousRow ? previousRow.lUomId : (this.state.lengthUoms?.[0]?.id || false),
            wUomId: previousRow ? previousRow.wUomId : (this.state.lengthUoms?.[0]?.id || false),
            qUomId: previousRow ? previousRow.qUomId : false,
        });
        // Force refresh
        this.state.dimensionRows = { ...this.state.dimensionRows };
    }

    _removeDimensionRow(productTmplId, index) {
        if (this.state.dimensionRows[productTmplId]) {
            this.state.dimensionRows[productTmplId].splice(index, 1);
            if (this.state.dimensionRows[productTmplId].length === 0) {
                this._addDimensionRow(productTmplId); // Keep at least one row
            }
            this.state.dimensionRows = { ...this.state.dimensionRows };
        }
    }

    _updateDimensionRow(productTmplId, index, field, value) {
        if (this.state.dimensionRows[productTmplId] && this.state.dimensionRows[productTmplId][index]) {
            this.state.dimensionRows[productTmplId][index][field] = value;
            this.state.dimensionRows = { ...this.state.dimensionRows };
        }
    }

    /**
     *  NEW: Fetch Profile Specification PDF and render using pdf.js
     */
    async updateProfilePdf(resId) {
        if (!resId) {
            this.state.profilePdfUrl = null;
            return;
        }

        try {
            const result = await this.rpc("/web/dataset/call_kw/profile.name/read", {
                model: "profile.name",
                method: "read",
                args: [[resId], ["profile_specification_pdf"]],
                kwargs: {},
            });

            if (result && result.length > 0 && result[0].profile_specification_pdf) {
                this.state.profilePdfUrl = `/web/content/profile.name/${resId}/profile_specification_pdf?download=false`;
                console.log(" Profile PDF found:", this.state.profilePdfUrl);

                // Reset zoom/rotation for new PDF
                this.state.pdfZoom = 1.0;
                this.state.pdfRotation = 0;

                // Wait for the template to update and refs to be available
                setTimeout(() => {
                    this._renderPDF(this.state.profilePdfUrl, true); // true = reset detection
                }, 150);
            } else {
                this.state.profilePdfUrl = null;
                console.log(" No PDF for this profile");
            }
        } catch (err) {
            console.error(" Failed to fetch profile PDF:", err);
            this.state.profilePdfUrl = null;
        }
    }

    _changeZoom(delta) {
        this.state.pdfZoom = Math.max(0.2, Math.min(5.0, this.state.pdfZoom + delta)); // Increased max zoom to 5.0
        this._renderPDF(this.state.profilePdfUrl);
    }

    _onZoomInputChange(ev) {
        const val = parseInt(ev.target.value) || 100;
        this.state.pdfZoom = Math.max(0.2, Math.min(5.0, val / 100));
        this._renderPDF(this.state.profilePdfUrl);
    }

    _rotatePDF() {
        this.state.pdfRotation = (this.state.pdfRotation + 90) % 360;
        this._renderPDF(this.state.profilePdfUrl);
    }

    async _renderPDF(url, resetDetection = false) {
        const canvas = this.__owl__.refs.pdfCanvas;
        if (!canvas || !url) return;

        try {
            if (!window.pdfjsLib) {
                const pdfjs = await import('/web/static/lib/pdfjs/build/pdf.js');
                window.pdfjsLib = window.pdfjsLib || pdfjs;
            }

            const pdfjsLib = window.pdfjsLib;
            pdfjsLib.GlobalWorkerOptions.workerSrc = '/web/static/lib/pdfjs/build/pdf.worker.js';

            const loadingTask = pdfjsLib.getDocument(url);
            const pdf = await loadingTask.promise;
            const page = await pdf.getPage(1);

            if (resetDetection) {
                const originalViewport = page.getViewport({ scale: 1 });
                if (originalViewport.height > originalViewport.width) {
                    this.state.pdfRotation = 90; // Default to horizontal if portrait
                }
            }

            const container = this.__owl__.refs.pdfContainer;
            const containerWidth = container.clientWidth - 40; // padding/margin

            // Calculate scale based on container width if zoom is 1.0 (Auto-fit)
            const baseViewport = page.getViewport({ scale: 1, rotation: this.state.pdfRotation });
            let finalScale = this.state.pdfZoom;

            // If we are at default zoom, let's make it fit width
            if (resetDetection) {
                finalScale = containerWidth / baseViewport.width;
                this.state.pdfZoom = finalScale;
            }

            const viewport = page.getViewport({ scale: finalScale, rotation: this.state.pdfRotation });
            const context = canvas.getContext('2d');

            canvas.height = viewport.height;
            canvas.width = viewport.width;

            const renderContext = {
                canvasContext: context,
                viewport: viewport
            };
            await page.render(renderContext).promise;
        } catch (err) {
            console.error(" Error rendering PDF:", err);
        }
    }

    // NEW: Store list of file uploads in state
    _updateFileUpload(productTmplId, ptalId, fileList) {
        const key = `${productTmplId}_${ptalId}`;

        // If deleted (fileList = null or empty)
        if (!fileList || fileList.length === 0) {
            delete this.state.fileUploads[key];
            console.log(` All files removed for ${key}`);
            return;
        }

        // Store list of files
        this.state.fileUploads[key] = fileList;
        console.log(`${fileList.length} files stored for ${key}`);
    }


    //  NEW: Store M2O value in state
    _updateM2OValue(productTmplId, ptalId, resId) {
        const key = `${productTmplId}_${ptalId}`;
        this.state.m2oValues[key] = resId;

        const product = this._findProduct(productTmplId);
        if (!product) return;

        const ptal = product.attribute_lines.find(l => l.id === ptalId);
        if (!ptal) return;

        const selectedPtav = ptal.attribute_values.find(v => ptal.selected_attribute_value_ids.includes(v.id));
        if (!selectedPtav) return;

        //  CRITICAL: set m2o_res_id so UI shows selected value
        selectedPtav.m2o_res_id = resId;
    }


    // Aggregate all file uploads for a specific product template
    _getFileUploadForProduct(productTmplId) {
        let allFiles = [];
        for (const key in this.state.fileUploads) {
            const [tmplId, ptalId] = key.split("_").map(Number);
            if (tmplId === Number(productTmplId)) {
                allFiles = [...allFiles, ...(this.state.fileUploads[key] || [])];
            }
        }
        return allFiles.length > 0 ? allFiles : null;
    }


    //  NEW: Retrieve M2O values for product
    _getM2OValuesForProduct(productTmplId) {
        const m2oValues = [];
        for (const key in this.state.m2oValues) {
            if (key.startsWith(`${productTmplId}_`)) {
                const ptalId = parseInt(key.split('_')[1]);
                m2oValues.push({
                    ptal_id: ptalId,
                    res_id: this.state.m2oValues[key]
                });
            }
        }
        return m2oValues;
    }

    // NEW: Store list of conditional file uploads in state
    _updateConditionalFileUpload(productTmplId, ptalId, fileList) {
        const key = `${productTmplId}_${ptalId}`;

        // If deleted (fileList = null or empty)
        if (!fileList || fileList.length === 0) {
            delete this.state.conditionalFileUploads[key];
            console.log(` All conditional files removed for ${key}`);
            return;
        }

        // Store list of files
        this.state.conditionalFileUploads[key] = fileList;
        console.log(` ${fileList.length} conditional files stored for ${key}`);
    }

    // Aggregate all conditional file uploads for a specific product template
    _getConditionalFileUploadForProduct(productTmplId) {
        let allFiles = [];
        for (const key in this.state.conditionalFileUploads) {
            const [tmplId, ptalId] = key.split("_").map(Number);
            if (tmplId === Number(productTmplId)) {
                allFiles = [...allFiles, ...(this.state.conditionalFileUploads[key] || [])];
            }
        }
        return allFiles.length > 0 ? allFiles : null;
    }

    _setDefaultThickness() {
        const mainProduct = this.state.products[0];
        if (!mainProduct) return;

        const thicknessAttributeLine = mainProduct.attribute_lines.find(
            ptal => ptal.attribute.name.toLowerCase() === 'thickness'
        );

        if (thicknessAttributeLine && thicknessAttributeLine.selected_attribute_value_ids.length === 0) {
            const defaultThicknessValue = thicknessAttributeLine.attribute_values.find(
                ptav => ptav.name === '5-7'
            );

            if (defaultThicknessValue) {
                this._updateProductTemplateSelectedPTAV(
                    mainProduct.product_tmpl_id,
                    thicknessAttributeLine.id,
                    defaultThicknessValue.id,
                    false
                );
            }
        }
    }

    async _loadData(onlyMainProduct) {
        const params = {
            product_template_id: this.props.productTemplateId,
            currency_id: this.props.currencyId,
            quantity: this.props.quantity,
            product_uom_id: this.props.productUOMId,
            company_id: this.props.companyId,
            ptav_ids: this.props.ptavIds,
            only_main_product: onlyMainProduct,
            material_line_id: this.props.materialLineId,
        };
        return await this.rpc('/crm_product_configurator/get_values', params);
    }

    async _createProduct(product) {
        return this.rpc('/crm_product_configurator/create_product', {
            product_template_id: product.product_tmpl_id,
            combination: this._getCombination(product),
        });
    }

    async _updateCombination(product, quantity) {
        return this.rpc('/crm_product_configurator/update_combination', {
            product_template_id: product.product_tmpl_id,
            combination: this._getCombination(product),
            currency_id: this.props.currencyId,
            so_date: this.props.soDate,
            quantity: quantity || 0.0,
            product_uom_id: this.props.productUOMId,
            company_id: this.props.companyId,
            pricelist_id: this.props.pricelistId,
        });
    }

    async _getOptionalProducts(product) {
        return this.rpc('/crm_product_configurator/get_optional_products', {
            product_template_id: product.product_tmpl_id,
            combination: this._getCombination(product),
            parent_combination: this._getParentsCombination(product),
            currency_id: this.props.currencyId,
            so_date: this.props.soDate,
            company_id: this.props.companyId,
            pricelist_id: this.props.pricelistId,
        });
    }

    async _addProduct(productTmplId) {
        const index = this.state.optionalProducts.findIndex(
            p => p.product_tmpl_id === productTmplId
        );
        if (index >= 0) {
            this.state.products.push(...this.state.optionalProducts.splice(index, 1));
            const product = this._findProduct(productTmplId);
            let newOptionalProducts = await this._getOptionalProducts(product);
            for (const newOptionalProductDict of newOptionalProducts) {
                const newProduct = this._findProduct(newOptionalProductDict.product_tmpl_id);
                if (newProduct) {
                    newOptionalProducts = newOptionalProducts.filter(
                        (p) => p.product_tmpl_id != newOptionalProductDict.product_tmpl_id
                    );
                    newProduct.parent_product_tmpl_ids.push(productTmplId);
                }
            }
            if (newOptionalProducts) this.state.optionalProducts.push(...newOptionalProducts);
        }
    }

    _removeProduct(productTmplId) {
        const index = this.state.products.findIndex(p => p.product_tmpl_id === productTmplId);
        if (index >= 0) {
            this.state.optionalProducts.push(...this.state.products.splice(index, 1));
            for (const childProduct of this._getChildProducts(productTmplId)) {
                childProduct.parent_product_tmpl_ids = childProduct.parent_product_tmpl_ids.filter(
                    id => id !== productTmplId
                );
                if (!childProduct.parent_product_tmpl_ids.length) {
                    this._removeProduct(childProduct.product_tmpl_id);
                    this.state.optionalProducts.splice(
                        this.state.optionalProducts.findIndex(
                            p => p.product_tmpl_id === childProduct.product_tmpl_id
                        ), 1
                    );
                }
            }
        }
    }

    async _setQuantity(productTmplId, quantity) {
        if (quantity <= 0) {
            if (productTmplId === this.env.mainProductTmplId) {
                const product = this._findProduct(productTmplId);
                const { price } = await this._updateCombination(product, 1);
                product.quantity = 1;
                product.price = parseFloat(price);
                return;
            }
            this._removeProduct(productTmplId);
        } else {
            const product = this._findProduct(productTmplId);
            const { price } = await this._updateCombination(product, quantity);
            product.quantity = quantity;
            product.price = parseFloat(price);
        }
    }

    async _updateProductTemplateSelectedPTAV(productTmplId, ptalId, ptavId, multiIdsAllowed) {
        const product = this._findProduct(productTmplId);
        let selectedIds = product.attribute_lines.find(ptal => ptal.id === ptalId).selected_attribute_value_ids;
        if (multiIdsAllowed) {
            const ptavID = parseInt(ptavId);
            if (!selectedIds.includes(ptavID)) {
                selectedIds.push(ptavID);
            } else {
                selectedIds = selectedIds.filter(ptav => ptav !== ptavID);
            }
        } else {
            selectedIds = [parseInt(ptavId)];
        }
        const ptal = product.attribute_lines.find(ptal => ptal.id === ptalId);
        ptal.selected_attribute_value_ids = selectedIds;

        // Sync quantity if this attribute is marked as is_quantity and it's not a custom value (handled by _updatePTAVCustomValue)
        if (ptal.attribute.is_quantity) {
            const selectedPtav = ptal.attribute_values.find(v => selectedIds.includes(v.id));
            if (selectedPtav && !selectedPtav.is_custom) {
                const qty = parseFloat(selectedPtav.name);
                if (!isNaN(qty)) {
                    this._setQuantity(productTmplId, qty);
                }
            }
        }
        this._checkExclusions(product);
        if (this._isPossibleCombination(product)) {
            const updatedValues = await this._updateCombination(product, product.quantity);
            Object.assign(product, updatedValues);
            if (!product.id && product.attribute_lines.every(ptal => ptal.create_variant === "always")) {
                const combination = this._getCombination(product);
                product.archived_combinations = product.archived_combinations.concat([combination]);
                this._checkExclusions(product);
            }
        }
    }

    _updatePTAVCustomValue(productTmplId, ptavId, customValue) {
        const product = this._findProduct(productTmplId);
        const ptal = product.attribute_lines.find(
            ptal => ptal.selected_attribute_value_ids.includes(ptavId)
        );
        if (ptal) {
            ptal.customValue = customValue;
            // Sync quantity if this attribute is marked as is_quantity
            if (ptal.attribute.is_quantity) {
                const qty = parseFloat(customValue);
                if (!isNaN(qty)) {
                    this._setQuantity(productTmplId, qty);
                }
            }
        }
    }

    _checkExclusions(product, checked = undefined) {
        const combination = this._getCombination(product);
        const exclusions = product.exclusions;
        const parentExclusions = product.parent_exclusions;
        const archivedCombinations = product.archived_combinations;
        const parentCombination = this._getParentsCombination(product);
        const childProducts = this._getChildProducts(product.product_tmpl_id);
        const ptavList = product.attribute_lines.flat().flatMap(ptal => ptal.attribute_values);
        ptavList.map(ptav => ptav.excluded = false);

        if (exclusions) {
            for (const ptavId of combination) {
                for (const excludedPtavId of exclusions[ptavId]) {
                    ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                }
            }
        }

        if (parentCombination) {
            for (const ptavId of parentCombination) {
                for (const excludedPtavId of (parentExclusions[ptavId] || [])) {
                    ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                }
            }
        }

        if (archivedCombinations) {
            for (const excludedCombination of archivedCombinations) {
                const ptavCommon = excludedCombination.filter((ptav) => combination.includes(ptav));
                if (ptavCommon.length === combination.length) {
                    for (const excludedPtavId of ptavCommon) {
                        ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                    }
                } else if (ptavCommon.length === (combination.length - 1)) {
                    const disabledPtavId = excludedCombination.find(
                        (ptav) => !combination.includes(ptav)
                    );
                    const excludedPtav = ptavList.find(ptav => ptav.id === disabledPtavId);
                    if (excludedPtav) {
                        excludedPtav.excluded = true;
                    }
                }
            }
        }

        const checkedProducts = checked || [];
        for (const optionalProductTmpl of childProducts) {
            if (!checkedProducts.includes(optionalProductTmpl)) {
                checkedProducts.push(optionalProductTmpl);
                this._checkExclusions(optionalProductTmpl, checkedProducts);
            }
        }
    }

    _findProduct(productTmplId) {
        return this.state.products.find(p => p.product_tmpl_id === productTmplId) ||
            this.state.optionalProducts.find(p => p.product_tmpl_id === productTmplId);
    }

    _getChildProducts(productTmplId) {
        return [
            ...this.state.products.filter(p => p.parent_product_tmpl_ids?.includes(productTmplId)),
            ...this.state.optionalProducts.filter(p => p.parent_product_tmpl_ids?.includes(productTmplId))
        ];
    }

    _getCombination(product) {
        return product.attribute_lines.flatMap(ptal => ptal.selected_attribute_value_ids);
    }

    _getParentsCombination(product) {
        let parentsCombination = [];
        for (const parentProductTmplId of product.parent_product_tmpl_ids || []) {
            parentsCombination.push(this._getCombination(this._findProduct(parentProductTmplId)));
        }
        return parentsCombination.flat();
    }

    _isPossibleCombination(product) {
        return product.attribute_lines.every(ptal => !ptal.attribute_values.find(
            ptav => ptal.selected_attribute_value_ids.includes(ptav.id)
        )?.excluded);
    }

    isPossibleConfiguration() {
        return [...this.state.products].every(p => this._isPossibleCombination(p));
    }

    _getCustomAttributeValues(product) {
        const customValues = [];
        for (const ptal of product.attribute_lines || []) {
            const selectedCustomPtav = ptal.attribute_values?.find(
                ptav => ptav.is_custom && ptal.selected_attribute_value_ids.includes(ptav.id)
            );

            if (selectedCustomPtav && ptal.customValue) {
                customValues.push({
                    ptav_id: selectedCustomPtav.id,
                    custom_value: ptal.customValue
                });
            }
        }
        return customValues;
    }

    _validateConditionalFiles() {
        const allProducts = [
            ...this.state.products,
            ...this.state.optionalProducts
        ];

        for (const product of allProducts) {
            if (!product.attribute_lines) continue;

            for (const ptal of product.attribute_lines) {
                // Check if any selected value requires a file
                const selectedPtavs = ptal.attribute_values.filter(v =>
                    ptal.selected_attribute_value_ids.includes(v.id)
                );

                const requiresFile = selectedPtavs.some(v => v.required_file);

                if (requiresFile) {
                    // Check if file is uploaded for this specific attribute line
                    const key = `${product.product_tmpl_id}_${ptal.id}`;
                    const hasFile = this.state.conditionalFileUploads[key];

                    if (!hasFile) {
                        return {
                            valid: false,
                            message: `Please upload a file for ${ptal.attribute.name}.`
                        };
                    }
                }
            }
        }
        return { valid: true };
    }

    _validateGelCoatRequirement() {
        const allProducts = [
            ...this.state.products,
            ...this.state.optionalProducts
        ];

        for (const product of allProducts) {
            if (!product.attribute_lines) continue;

            // Check if "Gel Coat REQ" is set to "Yes"
            let gelCoatRequired = false;
            for (const ptal of product.attribute_lines) {
                const attrName = ptal.attribute?.name?.toLowerCase() || '';
                if (attrName.includes('gel coat req') || attrName.includes('gelcoat req')) {
                    const selectedPtavs = ptal.attribute_values.filter(v =>
                        ptal.selected_attribute_value_ids.includes(v.id)
                    );

                    for (const ptav of selectedPtavs) {
                        if (ptav.name?.toLowerCase() === 'yes') {
                            gelCoatRequired = true;
                            console.log('🔍 Gel Coat REQ is set to Yes, validating Gel-coat selection');
                            break;
                        }
                    }
                    break;
                }
            }

            // If Gel Coat is required, check if it's selected
            if (gelCoatRequired) {
                for (const ptal of product.attribute_lines) {
                    if (ptal.attribute?.is_gelcoat_required_flag) {
                        const selectedPtavs = ptal.attribute_values.filter(v =>
                            ptal.selected_attribute_value_ids.includes(v.id)
                        );

                        // Check if a valid selection exists (not empty, not default placeholder)
                        const hasValidSelection = selectedPtavs.some(ptav => {
                            // For M2O attributes, check if m2o_res_id is set
                            if (ptal.attribute.display_type === 'm2o') {
                                return ptav.m2o_res_id && ptav.m2o_res_id > 0;
                            }
                            // For other types, check if name is not empty or placeholder
                            return ptav.name && ptav.name.trim() !== '' && !ptav.name.toLowerCase().includes('select');
                        });

                        if (!hasValidSelection) {
                            return {
                                valid: false,
                                message: `Gel-coat selection is required when "Gel Coat REQ" is set to "Yes". Please select a Gel-coat option.`
                            };
                        }
                    }
                }
            }
        }
        return { valid: true };
    }

    /**
     * NEW: Check if important M2O fields (Raisin Type, Gel-coat) are unselected
     */
    _getMissingImportantM2OValues() {
        const unselected = [];
        const mainProduct = this.state.products[0];
        if (!mainProduct || !mainProduct.attribute_lines) return unselected;

        for (const ptal of mainProduct.attribute_lines) {
            // Check display_type m2o
            if (ptal.attribute.display_type === 'm2o') {
                const name = ptal.attribute.name.toLowerCase();
                const key = `${mainProduct.product_tmpl_id}_${ptal.id}`;
                const resId = this.state.m2oValues[key];

                if (!resId || resId <= 0) {
                    if (name.includes('raisin type')) {
                        unselected.push('Raisin Type');
                    } else if (name.includes('gel-coat') || name.includes('gel coat')) {
                        // Skip if it's the "REQ" attribute or something else not matching the dropdown
                        if (!name.includes('req') && !name.includes('color')) {
                            // NEW: Only flag if Gel-coat IS actually required
                            if (this.env.isGelCoatRequired()) {
                                unselected.push('Gel-coat');
                            }
                        }
                    }
                }
            }
        }
        return unselected;
    }

    async onConfirm() {
        if (!this.isPossibleConfiguration()) return;

        //  NEW: Validate conditional files
        const validation = this._validateConditionalFiles();
        if (!validation.valid) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Missing Required File"),
                body: validation.message,
                confirmLabel: _t("Ok"),
            });
            return;
        }

        //  NEW: Validate Gel-coat requirement (HARD VALIDATION)
        const gelCoatValidation = this._validateGelCoatRequirement();
        if (!gelCoatValidation.valid) {
            this.env.services.dialog.add(AlertDialog, {
                title: _t("Gel-coat Required"),
                body: gelCoatValidation.message,
                confirmLabel: _t("Ok"),
            });
            return;
        }

        // SOFT VALIDATION: Check for Raisin Type / Gel-coat unselected
        // If hard validation passed but fields are still "Select", show soft warning
        const unselected = this._getMissingImportantM2OValues();
        if (unselected.length > 0 && !this.state.showConfirmSaveWarning) {
            this.state.showConfirmSaveWarning = true;
            return;
        }

        await this.onFinalConfirm();
    }

    onCancelConfirmWarning() {
        this.state.showConfirmSaveWarning = false;
    }

    async onFinalConfirm() {
        this.state.showConfirmSaveWarning = false;
        for (const product of this.state.products) {
            const needsVariant = !product.id && product.attribute_lines?.some(
                ptal => ptal.create_variant === "dynamic"
            );
            if (needsVariant) {
                const productId = await this._createProduct(product);
                product.id = parseInt(productId);
            }
        }

        const mainProduct = this.state.products.find(
            p => parseInt(p.product_tmpl_id) === parseInt(this.env.mainProductTmplId)
        );
        if (!mainProduct) return;

        const optionalProducts = this.state.products.filter(
            p => parseInt(p.product_tmpl_id) !== parseInt(this.env.mainProductTmplId)
        );

        // Sync first row of dimensions to standard attributes for each product
        for (const product of [...this.state.products, ...this.state.optionalProducts]) {
            this._syncFirstDimensionToAttributes(product);
        }

        const buildPayloadLine = (product) => {
            //  FIX: Get file from state instead of PTAV
            const file_upload = this._getFileUploadForProduct(product.product_tmpl_id);

            //  NEW: Get M2O values from state
            const m2o_values = this._getM2OValuesForProduct(product.product_tmpl_id);

            // NEW: Get conditional file upload from state
            const conditional_file_upload = this._getConditionalFileUploadForProduct(product.product_tmpl_id);

            return {
                product_id: parseInt(product.id),
                product_template_id: parseInt(product.product_tmpl_id),
                quantity: parseFloat(product.quantity) > 0 ? parseFloat(product.quantity) : 1,
                price: parseFloat(product.price) >= 0 ? parseFloat(product.price) : 0,

                //  Filter out file_upload (M2O is kept for linkage but ALSO sent in m2o_values)
                ptav_ids: this._getCombination(product)
                    .filter(id => {
                        const ptav = product.attribute_lines
                            .flatMap(a => a.attribute_values)
                            .find(v => v.id === id);
                        const displayType = ptav?.attribute_id?.display_type;
                        return displayType !== "file_upload";
                    })
                    .map(id => parseInt(id)),

                custom_attribute_values: this._getCustomAttributeValues(product),
                file_upload: file_upload,
                m2o_values: m2o_values, //  NEW
                conditional_file_upload: conditional_file_upload, // NEW
                dimensions: (this.state.dimensionRows[product.product_tmpl_id] || []).map(r => ({
                    ...r,
                    length: r.length === "" ? 0 : r.length,
                    width: r.width === "" ? 0 : r.width,
                    qty: r.qty === "" ? 1 : r.qty
                })), // NEW
                material_line_id: product.product_tmpl_id === this.env.mainProductTmplId ? this.props.materialLineId : false,
            };
        };

        const crmLeadId = parseInt(this.props.crmLeadId);
        if (!crmLeadId) return;

        const payload = {
            main_product: buildPayloadLine(mainProduct),
            optional_products: optionalProducts.map(buildPayloadLine),
            crm_lead_id: crmLeadId,
        };

        console.log("🔍 Built payload:", payload);
        console.log("🔍 File upload in payload:", payload.main_product.file_upload);
        console.log("🔍 M2O values in payload:", payload.main_product.m2o_values);

        try {
            const res = await this.rpc('/crm_product_configurator/save_to_crm', payload);
            if (res && res.success) {
                this.props.close?.();
            } else {
                console.error("Error saving to CRM:", res?.error || "Unknown error");
            }
        } catch (err) {
            console.error("RPC failed:", err);
        }
    }

    onDiscard() {
        try {
            if (!this.props.edit && typeof this.props.discard === 'function') {
                this.props.discard();
            }
            this.props.close?.();
        } catch (err) {
            console.error("Discard error:", err);
        }
    }
}