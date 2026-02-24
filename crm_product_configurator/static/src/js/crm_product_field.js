/** @odoo-module **/

import { Many2OneField } from "@web/views/fields/many2one/many2one_field";
import { useService } from "@web/core/utils/hooks";
import { x2ManyCommands } from "@web/core/orm_service";
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { useEffect } from "@odoo/owl";
import { crmProductConfiguratorDialog } from "./product_configurator_dialog/product_configurator_dialog";

export class CrmProductMany2One extends Many2OneField {
    static template = "CrmMaterialLineProductField";
    static components = { Many2OneField };

    setup() {
        super.setup();
        this.dialog = useService("dialog");
        this.orm = useService("orm");

        this.currentValue = this.value;

        useEffect(() => {
            const record = this.props.record;
            if (record && record.isInEdition && this.value) {
                const currentVal = this.currentValue;
                const newVal = record.data[this.props.name];
                if (!currentVal || currentVal[0] !== newVal[0]) {
                    this._onProductTemplateUpdate();
                }
                this.currentValue = newVal;
            }
        });
    }

    get configurationButtonHelp() {
        return _t("Edit Product Configuration");
    }

    onProductTemplateChange(ev) {
        const selectedId = ev.detail.value?.id;
        const selectedName = ev.detail.value?.display_name;

        if (selectedId) {
            this.props.record.update({ product_template_id: [selectedId, selectedName] });
        } else {
            this.props.record.update({ product_template_id: false });
        }
    }

    onEditConfiguration() {
        this._openConfigurator(true);
    }

    async _onProductTemplateUpdate() {
        const record = this.props.record;
        const templateId = record?.data?.product_template_id?.[0];

        if (!templateId) {
            return;
        }

        try {
            const variantInfo = await this.orm.call('product.template', 'get_single_product_variant', [templateId]);
            const [configMode] = await this.orm.read('product.template', [templateId], ['product_config_mode']);

            if (variantInfo?.product_id) {
                await record.update({
                    product_id: [variantInfo.product_id.id, variantInfo.product_id.display_name],
                });
            } else {
                if (!configMode?.product_config_mode || configMode.product_config_mode === 'configurator') {
                    this._openConfigurator(false);
                } else {
                    this._openGridConfigurator(false);
                }
            }
        } catch (error) {
        }
    }

    async _openConfigurator(edit = false) {

        const record = this.props.record;
        const templateId = record?.data?.product_template_id?.[0];
        if (!templateId) return;

        let ptavIds = [];
        let customAttributes = [];

        // START: Bulletproof Robust Fetch Logic
        // In Odoo 18, resId might be in record.resId or record.data.id
        const resId = record.resId || (record.data && typeof record.data.id === 'number' ? record.data.id : false);

        if (resId) {
            try {
                // Fetching Standard and No-Variant attributes
                const results = await this.orm.read('crm.material.line', [resId], [
                    'product_template_attribute_value_ids',
                    'product_no_variant_attribute_value_ids',
                    'product_custom_attribute_value_ids'
                ]);

                if (results && results.length > 0) {
                    const lineData = results[0];
                    const variantPtavIds = lineData.product_template_attribute_value_ids || [];
                    const noVariantPtavIds = lineData.product_no_variant_attribute_value_ids || [];

                    // Merge and cleanup IDs
                    ptavIds = [...new Set([...variantPtavIds, ...noVariantPtavIds])].filter(id => typeof id === 'number');

                    // Fetching Custom Attribute Values (e.g. Length, Width text)
                    const customValueIds = lineData.product_custom_attribute_value_ids || [];
                    if (customValueIds.length > 0) {
                        const customValues = await this.orm.read('product.attribute.custom.value', customValueIds, [
                            'custom_product_template_attribute_value_id',
                            'custom_value'
                        ]);
                        customAttributes = customValues.map(cv => {
                            const ptavVal = cv.custom_product_template_attribute_value_id;
                            return {
                                ptavId: Array.isArray(ptavVal) ? ptavVal[0] : ptavVal,
                                value: cv.custom_value
                            };
                        }).filter(attr => attr.ptavId && attr.value);
                    }
                }
            } catch (err) {
                console.error("Robust fetch failed:", err);
            }
        }

        // Fallback Logic (if not fetched or first configuration)
        if (ptavIds.length === 0) {
            const ptavRecords = record.data.product_template_attribute_value_ids?.records || [];
            ptavIds = ptavRecords.map(r => r.resId || (Array.isArray(r.data.id) ? r.data.id[0] : r.data.id));

            if (edit || ptavIds.length > 0) {
                const noVariantRecords = record.data.product_no_variant_attribute_value_ids?.records || [];
                const noVariantIds = noVariantRecords.map(r => r.resId || (Array.isArray(r.data.id) ? r.data.id[0] : r.data.id));
                ptavIds = [...new Set([...ptavIds, ...noVariantIds])];

                customAttributes = (record.data.product_custom_attribute_value_ids?.records || []).map(r => ({
                    ptavId: r.data.custom_product_template_attribute_value_id?.[0] || r.data.custom_product_template_attribute_value_id,
                    value: r.data.custom_value,
                })).filter(attr => attr.ptavId);
            }
        }
        // END: Robust Fetch Logic

        this.dialog.add(crmProductConfiguratorDialog, {
            productTemplateId: templateId,
            ptavIds,
            customAttributeValues: customAttributes,
            quantity: record.data.quantity || 1.0,
            productUOMId: record.data.product_uom?.[0],
            companyId: record.data.company_id?.[0],
            currencyId: record.data.currency_id?.[0],
            crmLeadId: record?.data?.lead_id?.[0] || false,
            materialLineId: resId,
            edit,
            save: async (mainProduct, optionalProducts) => {
                await this.applyProduct(record, mainProduct);
                for (const opt of optionalProducts || []) {
                    if (!opt.id || (opt.quantity || 0) <= 0) continue;
                    const line = await record.model.root.data.material_line_ids.addNewRecord({ position: 'bottom' });
                    await this.applyProduct(line, opt);
                }
            },

            discard: () => {
                if (!edit) {
                    record.model.root.data.material_line_ids.delete(record);
                }
            },
        });
    }

    async applyProduct(record, product) {
        const customAttrs = [x2ManyCommands.set([])];
        for (const ptal of product.attribute_lines || []) {
            const customVal = ptal.attribute_values?.find(
                ptav => ptav.is_custom && ptal.selected_attribute_value_ids.includes(ptav.id)
            );
            if (customVal) {
                customAttrs.push(
                    x2ManyCommands.create(undefined, {
                        custom_product_template_attribute_value_id: [customVal.id, ""],
                        custom_value: ptal.customValue,
                    })
                );
            }
        }

        const noVariantPTAVIds = (product.attribute_lines || [])
            .filter(ptal => ptal.create_variant === "no_variant")
            .flatMap(ptal => ptal.selected_attribute_value_ids || []);

        await record.update({
            product_id: [product.id, product.display_name],
            product_no_variant_attribute_value_ids: [x2ManyCommands.set(noVariantPTAVIds)],
            product_custom_attribute_value_ids: customAttrs,
            quantity: product.quantity || 1.0,
        });
    }

    async _openGridConfigurator(edit = false) {
        // Placeholder for grid support if needed
    }
}

registry.category("fields").add("crm_product_many2one", {
    component: CrmProductMany2One,
    supportedTypes: ["many2one"],
    displayName: "Many2One ",
});