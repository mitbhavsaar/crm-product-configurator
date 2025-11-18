/** @odoo-module **/

import { _t } from "@web/core/l10n/translation";
import { Component, onWillStart, useState, useSubEnv,useEffect } from "@odoo/owl";
import { Dialog } from '@web/core/dialog/dialog';
import { CrmProductList } from "../product_list/product_list";
import { rpc } from "@web/core/network/rpc";
export class crmProductConfiguratorDialog extends Component {
    static components = { Dialog, CrmProductList};
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
        
        edit: { type: Boolean, optional: true },
        save: Function,
        discard: Function,
        close: Function, // This is the close from the env of the Dialog Component
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

        });
        /**
         * Initializes sub-environment for product customization.
         */
        useSubEnv({
            mainProductTmplId: this.props.productTemplateId,
            currencyId: this.props.currencyId,
            addProduct: this._addProduct.bind(this),
            removeProduct: this._removeProduct.bind(this),
            setQuantity: this._setQuantity.bind(this),
            updateProductTemplateSelectedPTAV: this._updateProductTemplateSelectedPTAV.bind(this),
            updatePTAVCustomValue: this._updatePTAVCustomValue.bind(this),
            isPossibleCombination: this._isPossibleCombination,
        });
        useEffect(() => {
        }, () => [this.state.products]);
        /**
         * Initializes data and performs setup actions before starting.
         * Loads data, sets state, updates custom values, and checks exclusions.
        */
        onWillStart(async () => {
            const { products, optional_products } = await this._loadData(this.props.edit);

            this.state.products = products;
            this.state.optionalProducts = optional_products;

            for (const customValue of this.props.customAttributeValues) {
                this._updatePTAVCustomValue(
                    this.env.mainProductTmplId,
                    customValue.ptavId,
                    customValue.value
                );
            }

            if (this.state.products.length > 0) {
                this._checkExclusions(this.state.products[0]);
            } else {
            }
        });

    }
    /**
         * Loads data for the product configurator.
    */
    async _loadData(onlyMainProduct) {
        const params = {
            product_template_id: this.props.productTemplateId,
            currency_id: this.props.currencyId,
            quantity: this.props.quantity,
            product_uom_id: this.props.productUOMId,
            company_id: this.props.companyId,
            ptav_ids: this.props.ptavIds,
            only_main_product: onlyMainProduct,
        };
        const result = await this.rpc('/crm_product_configurator/get_values', params);
        return result;
    }

    /**
     * Creates a product using the provided data.
     */
    async _createProduct(product) {
        return this.rpc('/crm_product_configurator/create_product', {
            product_template_id: product.product_tmpl_id,
            combination: this._getCombination(product),
        });
    }
    /**
     * Updates a product combination with the provided quantity.
     */
    async _updateCombination(product, quantity) {
        return this.rpc('/crm_product_configurator/update_combination', {
            product_template_id: product.product_tmpl_id,
            combination: this._getCombination(product),
            currency_id: this.props.currencyId,
            so_date: this.props.soDate,
            quantity: quantity,
            product_uom_id: this.props.productUOMId,
            company_id: this.props.companyId,
            pricelist_id: this.props.pricelistId,
        });
    }
    /**
     * Retrieves optional products available for the given product.
     */
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
    /**
     * Add the product to the list of products and fetch his optional products.
     */
    async _addProduct(productTmplId) {
        const index = this.state.optionalProducts.findIndex(
            p => p.product_tmpl_id === productTmplId
        );
        if (index >= 0) {
            this.state.products.push(...this.state.optionalProducts.splice(index, 1));
            // Fetch optional product from the server with the parent combination.
            const product = this._findProduct(productTmplId);
            let newOptionalProducts = await this._getOptionalProducts(product);
            for(const newOptionalProductDict of newOptionalProducts) {
                // If the optional product is already in the list, add the id of the parent product
                // template in his list of `parent_product_tmpl_ids` instead of adding a second time
                // the product.
                const newProduct = this ._findProduct(newOptionalProductDict.product_tmpl_id);
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
    /**
     * Remove the product and his optional products from the list of products.
     */
    _removeProduct(productTmplId) {
        const index = this.state.products.findIndex(p => p.product_tmpl_id === productTmplId);
        if (index >= 0) {
            this.state.optionalProducts.push(...this.state.products.splice(index, 1));
            for (const childProduct of this._getChildProducts(productTmplId)) {
                // Optional products might have multiple parents so we don't want to remove them if
                // any of their parents are still on the list of products.
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
    /**
     * Set the quantity of the product to a given value.
     */
    async _setQuantity(productTmplId, quantity) {
        if (quantity <= 0) {
            if (productTmplId === this.env.mainProductTmplId) {
                const product = this._findProduct(productTmplId);
                const { price } = await this._updateCombination(product, 1);
                product.quantity = 1;
                product.price = parseFloat(price);
                return;
            };
            this._removeProduct(productTmplId);
        } else {
            const product = this._findProduct(productTmplId);
            const { price } = await this._updateCombination(product, quantity);
            product.quantity = quantity;
            product.price = parseFloat(price);
        }
    }
    /**
     * Change the value of `selected_attribute_value_ids` on the given PTAL in the product.
     */
    async _updateProductTemplateSelectedPTAV(productTmplId, ptalId, ptavId, multiIdsAllowed) {
        const product = this._findProduct(productTmplId);
        let selectedIds = product.attribute_lines.find(ptal => ptal.id === ptalId).selected_attribute_value_ids;
        if (multiIdsAllowed) {
            const ptavID = parseInt(ptavId);
            if (!selectedIds.includes(ptavID)){
                selectedIds.push(ptavID);
            } else {
                selectedIds = selectedIds.filter(ptav => ptav !== ptavID);
            }

        } else {
            selectedIds = [parseInt(ptavId)];
        }
        product.attribute_lines.find(ptal => ptal.id === ptalId).selected_attribute_value_ids = selectedIds;
        this._checkExclusions(product);
        if (this._isPossibleCombination(product)) {
            const updatedValues = await this._updateCombination(product, product.quantity);
            Object.assign(product, updatedValues);
            // When a combination should exist but was deleted from the database, it should not be
            // selectable and considered as an exclusion.
            if (!product.id && product.attribute_lines.every(ptal => ptal.create_variant === "always")) {
                const combination = this._getCombination(product);
                product.archived_combinations = product.archived_combinations.concat([combination]);
                this._checkExclusions(product);
            }
        }
    }
    /**
     * Set the custom value for a given custom PTAV.
     */
    _updatePTAVCustomValue(productTmplId, ptavId, customValue) {
        const product = this._findProduct(productTmplId);
        product.attribute_lines.find(
            ptal => ptal.selected_attribute_value_ids.includes(ptavId)
        ).customValue = customValue;
    }
    /**
     * Check the exclusions of a given product and his child.
     */
    _checkExclusions(product, checked=undefined) {
        const combination = this._getCombination(product);
        const exclusions = product.exclusions;
        const parentExclusions = product.parent_exclusions;
        const archivedCombinations = product.archived_combinations;
        const parentCombination = this._getParentsCombination(product);
        const childProducts = this._getChildProducts(product.product_tmpl_id)
        const ptavList = product.attribute_lines.flat().flatMap(ptal => ptal.attribute_values)
        ptavList.map(ptav => ptav.excluded = false); // Reset all the values
        if (exclusions) {
            for(const ptavId of combination) {
                for(const excludedPtavId of exclusions[ptavId]) {
                    ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                }
            }
        }
        if (parentCombination) {
            for(const ptavId of parentCombination) {
                for(const excludedPtavId of (parentExclusions[ptavId]||[])) {
                    ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                }
            }
        }
        if (archivedCombinations) {
            for(const excludedCombination of archivedCombinations) {
                const ptavCommon = excludedCombination.filter((ptav) => combination.includes(ptav));
                if (ptavCommon.length === combination.length) {
                    for(const excludedPtavId of ptavCommon) {
                        ptavList.find(ptav => ptav.id === excludedPtavId).excluded = true;
                    }
                } else if (ptavCommon.length === (combination.length - 1)) {
                    // In this case we only need to disable the remaining ptav
                    const disabledPtavId = excludedCombination.find(
                        (ptav) => !combination.includes(ptav)
                    );
                    const excludedPtav = ptavList.find(ptav => ptav.id === disabledPtavId)
                    if (excludedPtav) {
                        excludedPtav.excluded = true;
                    }
                }
            }
        }
        const checkedProducts = checked || [];
        for(const optionalProductTmpl of childProducts) {
             // if the product is not checked for exclusions
            if (!checkedProducts.includes(optionalProductTmpl)) {
                checkedProducts.push(optionalProductTmpl); // remember that this product is checked
                this._checkExclusions(optionalProductTmpl, checkedProducts);
            }
        }
    }
    /**
     * Return the product given his template id.
     */
    _findProduct(productTmplId) {
        const product = this.state.products.find(p => p.product_tmpl_id === productTmplId) ||
                        this.state.optionalProducts.find(p => p.product_tmpl_id === productTmplId);
        return product;
    }

    /**
     * Return the list of dependents products for a given product.
     */
    _getChildProducts(productTmplId) {
        return [
            ...this.state.products.filter(p => p.parent_product_tmpl_ids?.includes(productTmplId)),
            ...this.state.optionalProducts.filter(p => p.parent_product_tmpl_ids?.includes(productTmplId))
        ]
    }
    /**
     * Return the selected PTAV of the product, as a list of `product.template.attribute.value` id.
     */
    _getCombination(product) {
        return product.attribute_lines.flatMap(ptal => ptal.selected_attribute_value_ids);
    }
    /**
     * Return the selected PTAV of all the product parents, as a list of
     * `product.template.attribute.value` id.
     */
    _getParentsCombination(product) {
        let parentsCombination = [];
        for(const parentProductTmplId of product.parent_product_tmpl_ids || []) {
            parentsCombination.push(this._getCombination(this._findProduct(parentProductTmplId)));
        }
        return parentsCombination.flat();
    }
    /**
     * Check if a product has a valid combination.
     */
    _isPossibleCombination(product) {
        return product.attribute_lines.every(ptal => !ptal.attribute_values.find(
            ptav => ptal.selected_attribute_value_ids.includes(ptav.id)
        )?.excluded);
    }

    /**
     * Check if all the products selected have a valid combination.
     */
    isPossibleConfiguration() {
        return [...this.state.products].every(
            p => this._isPossibleCombination(p)
        );
    }
    /**
     * Confirm the current combination(s).
     */
    async onConfirm() {
        if (!this.isPossibleConfiguration()) return;

        // Step 1: Dynamically create variant if needed
        for (const product of this.state.products) {
            const needsVariant = !product.id && product.attribute_lines?.some(ptal => ptal.create_variant === "dynamic");
            if (needsVariant) {
                const productId = await this._createProduct(product);  // Ensure this creates and returns the variant ID
                product.id = parseInt(productId);
            }
        }

        // Step 2: Identify main product
        const mainProduct = this.state.products.find(
            p => parseInt(p.product_tmpl_id) === parseInt(this.env.mainProductTmplId)
        );
        if (!mainProduct) return;

        // Step 3: Optional products
        const optionalProducts = this.state.products.filter(
            p => parseInt(p.product_tmpl_id) !== parseInt(this.env.mainProductTmplId)
        );

        // Step 4: Build payload line
        const buildPayloadLine = (product) => ({
            product_id: parseInt(product.id),  // Direct variant ID
            product_template_id: parseInt(product.product_tmpl_id),
            quantity: parseFloat(product.quantity) > 0 ? parseFloat(product.quantity) : 1,
            price: parseFloat(product.price) >= 0 ? parseFloat(product.price) : 0,
            ptav_ids: (this._getCombination(product) || []).map(id => parseInt(id)),
        });

        const crmLeadId = parseInt(this.props.crmLeadId);
        if (!crmLeadId) return;

        const payload = {
            main_product: buildPayloadLine(mainProduct),
            optional_products: optionalProducts.map(buildPayloadLine),
            crm_lead_id: crmLeadId,
        };

        // Step 5: Call backend
        try {
            const res = await this.rpc('/crm_product_configurator/save_to_crm', payload);
            if (res && res.success) {
                this.props.close?.();  // Close dialog
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
        }
    }
}
