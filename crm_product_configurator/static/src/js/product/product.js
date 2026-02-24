/** @odoo-module */

import { Component, useState } from "@odoo/owl";
import { formatCurrency } from "@web/core/currency";
import {
    ProductTemplateAttributeLine as PTAL
} from "../product_template_attribute_line/product_template_attribute_line";

export class Product extends Component {
    static components = { PTAL };
    static template = "crm_product_configurator.product";
    static props = {
        id: { type: [Number, { value: false }], optional: true },
        product_tmpl_id: Number,
        display_name: String,
        description_sale: [Boolean, String], // backend sends 'false' when there is no description
        price: { type: [Number, { value: false }], optional: true },
        quantity: Number,
        attribute_lines: Object,
        optional: Boolean,
        imageURL: { type: String, optional: true },
        archived_combinations: Array,
        exclusions: Object,
        parent_exclusions: Object,
        parent_product_tmpl_ids: { type: Array, element: Number, optional: true },
        dimensionRows: { type: Array, optional: true },
    };

    setup() {
        this.warningState = useState({
            dimensions: {}, // { [row_index]: { length: "", width: "" } }
        });
        // Bind methods to ensure 'this' is correct in templates
        this.validateNumeric = this.validateNumeric.bind(this);
        this.updateDimensionRow = this.updateDimensionRow.bind(this);
        this.addDimensionRow = this.addDimensionRow.bind(this);
        this.removeDimensionRow = this.removeDimensionRow.bind(this);
        this.hasDimensionRows = this.hasDimensionRows.bind(this);
        this.getDimensionRows = this.getDimensionRows.bind(this);
        this.getUomOptions = this.getUomOptions.bind(this);
    }

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * Increase the quantity of the product in the state.
     */
    increaseQuantity() {
        this.env.setQuantity(this.props.product_tmpl_id, this.props.quantity + 1);
    }

    /**
     * Set the quantity of the product in the state.
     *
     * @param {Event} event
     */
    setQuantity(event) {
        const newQty = parseFloat(event.target.value);
        this.env.setQuantity(this.props.product_tmpl_id, newQty);
    }

    /**
     * Decrease the quantity of the product in the state.
     */
    decreaseQuantity() {
        this.env.setQuantity(this.props.product_tmpl_id, this.props.quantity - 1);
    }

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Return the display name without the parenthetical variants/units.
     * @return {String}
     */
    get cleanedDisplayName() {
        if (!this.props.display_name) return "";
        return this.props.display_name.split(" (")[0].trim();
    }

    /**
     * Returns true if any attribute in this product is marked as a quantity attribute.
     * @return {Boolean}
     */
    get hasCustomQty() {
        const lines = Array.isArray(this.props.attribute_lines) ? this.props.attribute_lines : Object.values(this.props.attribute_lines);
        return lines.some(l => l.attribute.is_quantity);
    }

    /**
     * Return the price, in the format of the given currency.
     *
     * @return {String} - The price, in the format of the given currency.
     */
    getFormattedPrice() {
        return formatCurrency(this.props.price, this.env.currencyId);
    }
    isVisible(ptal) {
        const attrName = ptal.attribute.name.toLowerCase();

        // 1. Check if current attribute is "Gel-coat"
        if (attrName === "gel-coat" || attrName === "gel coat") {
            const lines = Array.isArray(this.props.attribute_lines) ? this.props.attribute_lines : Object.values(this.props.attribute_lines);
            const requiredAttr = lines.find(l => l.attribute.is_gelcoat_required_flag);

            if (requiredAttr) {
                const selectedId = requiredAttr.selected_attribute_value_ids[0];
                if (selectedId) {
                    const selectedValue = requiredAttr.attribute_values.find(v => v.id === selectedId);
                    if (selectedValue && selectedValue.name.toLowerCase() === "yes") {
                        return true;
                    }
                }
                return false;
            }
        }

        // 2. Hide standard Length/Width and their UOMs if dimension rows are active
        if (this.hasDimensionRows()) {
            const isStandardDim = attrName === 'length' || attrName === 'width' ||
                attrName.includes('length uom') || attrName.includes('width uom');
            if (isStandardDim) {
                return false;
            }
        }

        // 3. Dynamic Visibility based on "Type of FRP Sheet" & "Gelcoat" selection
        const frpType = this.getSelectedValue("type of frp sheet"); // "Opaque" or "Translucent"

        // Hide "Color Pigment" if Translucent
        if (attrName.includes("color") && (attrName.includes("pigment") || attrName.includes("pintpant"))) {
            if (frpType && frpType.trim().toLowerCase() === "translucent") {
                return false;
            }
        }

        // Hide "Gelcoat Color" and "Resin Color" from main loop (handled manually side-by-side)
        if (["gelcoat color", "gel coat color", "gel-coat color", "resin color", "resin colour", "raisin color", "raisign color"].includes(attrName)) {
            return false;
        }

        return true;
    }

    // NEW: Get paired attribute (e.g. Resin Color for Resin Type)
    getPairedColorAttribute(parentPtal) {
        const parentName = parentPtal.attribute.name.toLowerCase();
        const lines = Array.isArray(this.props.attribute_lines) ? this.props.attribute_lines : Object.values(this.props.attribute_lines);

        let colorPtal = null;
        if (parentName === "resin type" || parentName === "raisin type") {
            colorPtal = lines.find(l => {
                const name = l.attribute.name.toLowerCase();
                return ["resin color", "resin colour", "raisin color", "raisign color"].includes(name);
            });
        } else if (parentName === "gelcoat" || parentName === "gel-coat") {
            colorPtal = lines.find(l => {
                const name = l.attribute.name.toLowerCase();
                return ["gelcoat color", "gel coat color", "gel-coat color"].includes(name);
            });
        }

        if (!colorPtal) return null;

        // Special visibility check for Gelcoat Color
        if (["gelcoat color", "gel coat color", "gel-coat color"].includes(colorPtal.attribute.name.toLowerCase())) {
            const gelCoatReq = this.getSelectedValue("gel coat req");
            if (gelCoatReq && gelCoatReq.toLowerCase() === "no") return null;
        }

        return colorPtal;
    }

    // NEW: Return PTAL with filtered values
    getFilteredPTAL(ptal) {
        const filtered = {
            ...ptal,
            attribute_values: this.getVisibleAttributeValues(ptal, ptal.attribute_values)
        };
        // Also filter m2o_values if they exist
        if (ptal.attribute.m2o_values) {
            filtered.attribute = {
                ...ptal.attribute,
                m2o_values: this.getVisibleAttributeValues(ptal, ptal.attribute.m2o_values)
            };
        }
        return filtered;
    }

    // NEW: Helper to get selected value string for logic checks
    getSelectedValue(attributeName) {
        const lines = Array.isArray(this.props.attribute_lines) ? this.props.attribute_lines : Object.values(this.props.attribute_lines);
        const ptal = lines.find(l => l.attribute.name.toLowerCase() === attributeName.toLowerCase());
        if (!ptal || !ptal.selected_attribute_value_ids.length) return null;
        const selectedId = ptal.selected_attribute_value_ids[0];
        const val = ptal.attribute_values.find(v => v.id === selectedId);
        if (!val || !val.name) return null;
        // Clean name (remove " (+...)" price suffix)
        return val.name.split(" (")[0].trim();
    }

    // NEW: Filter dropdown options based on "Type of FRP Sheet"
    getVisibleAttributeValues(ptal, values) {
        const attrName = ptal.attribute.name.toLowerCase();
        let list = values || ptal.attribute_values;

        // Apply filtering for Resin Type and Gelcoat variants
        const filteredAttributes = [
            "resin type", "gelcoat", "gel-coat", "gel coat", "raisin type",
            "rasign type", "raisign type", "resin", "raisin", "rasign"
        ];

        if (filteredAttributes.includes(attrName)) {
            const frpType = this.getSelectedValue("type of frp sheet");

            if (frpType && frpType.toLowerCase() === "opaque") {
                // Return records where is_opaque is true
                return list.filter(v => v.is_opaque);
            } else if (frpType && frpType.toLowerCase() === "translucent") {
                // Return records where is_translucent is true
                return list.filter(v => v.is_translucent);
            }
        }

        return list;
    }

    hasDimensionRows() {
        return (this.props.dimensionRows || []).length > 0;
    }

    getDimensionRows() {
        return this.props.dimensionRows || [];
    }

    addDimensionRow() {
        this.env.addDimensionRow(this.props.product_tmpl_id);
    }

    removeDimensionRow(index) {
        this.env.removeDimensionRow(this.props.product_tmpl_id, index);
    }

    updateDimensionRow(index, field, value) {
        // Allow empty string for length/width to show placeholder
        let val = value;
        if (field.includes('Id')) {
            val = parseInt(value);
        }
        // For numeric fields, we keep as string if empty, otherwise we could parseFloat here 
        // but validateNumeric handles the input sanitization. 
        // If we parseFloat here, "" becomes NaN which usually means we'd fallback to 0. 
        // We want to avoid fallback to 0 for empty string.
        this.env.updateDimensionRow(this.props.product_tmpl_id, index, field, val);
    }

    getUomOptions(type) {
        return this.env.getUomOptions(this.props.product_tmpl_id, type);
    }

    validateNumeric(event, index, field) {
        let val = event.target.value;
        const isValid = /^[0-9]*\.?[0-9]*$/.test(val);

        // If index is provided, it's a dimension row. Otherwise it's a standard attribute (like strictly_numeric)
        if (index !== undefined && field) {
            if (!this.warningState.dimensions[index]) {
                this.warningState.dimensions[index] = { length: "", width: "", qty: "" };
            }
            this.warningState.dimensions[index][field] = isValid ? "" : "Numeric Values Only !";
        }

        // Remove any non-numeric and non-decimal characters
        val = val.replace(/[^0-9.]/g, '');

        // Ensure only one decimal point
        const parts = val.split('.');
        if (parts.length > 2) {
            val = parts[0] + '.' + parts.slice(1).join('');
        }

        // Limit to 2 decimal places
        if (parts.length > 1) {
            val = parts[0] + '.' + parts[1].substring(0, 2);
        }

        event.target.value = val;
    }
}
