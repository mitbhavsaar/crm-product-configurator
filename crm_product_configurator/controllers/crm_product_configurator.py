from odoo.http import Controller, request, route
from odoo import http
import base64
import logging
import traceback

_logger = logging.getLogger(__name__)


class ProductConfiguratorController(Controller):

    @route('/crm_product_configurator/get_values', type='json', auth='user')
    def get_product_configurator_values(
        self,
        product_template_id,
        quantity,
        currency_id=None,
        product_uom_id=None,
        company_id=None,
        ptav_ids=None,
        only_main_product=False,
        material_line_id=None,
    ):
        """ Return all product information needed for the product configurator.
        """
        if company_id:
            request.update_context(allowed_company_ids=[company_id])

        product_template = request.env['product.template'].browse(product_template_id)
        combination = request.env['product.template.attribute.value']

        if ptav_ids:
            combination = request.env['product.template.attribute.value'].browse(ptav_ids).filtered(
                lambda ptav: ptav.product_tmpl_id.id == product_template_id
            )
            # Set missing attributes (unsaved no_variant attributes, or new attribute on existing product)
            unconfigured_ptals = (
                product_template.attribute_line_ids - combination.attribute_line_id
            ).filtered(lambda loop_ptal: loop_ptal.attribute_id.display_type != 'multi')
            combination += unconfigured_ptals.mapped(
                lambda loop_ptal: loop_ptal.product_template_value_ids._only_active()[:1]
            )

        if not combination:
            combination = product_template._get_first_possible_combination()

        return dict(
            products=[
                dict(
                    **self._get_product_information(
                        product_template,
                        combination,
                        currency_id,
                        quantity=quantity,
                        product_uom_id=product_uom_id,
                        material_line_id=material_line_id,
                    ),
                    parent_product_tmpl_ids=[],
                )
            ],
            optional_products=[
                dict(
                    **self._get_product_information(
                        optional_product_template,
                        optional_product_template._get_first_possible_combination(
                            parent_combination=combination
                        ),
                        currency_id,
                        # giving all the ptav of the parent product to get all the exclusions
                        parent_combination=product_template.attribute_line_ids.product_template_value_ids,
                        material_line_id=None,
                    ),
                    parent_product_tmpl_ids=[product_template.id],
                )
                for optional_product_template in product_template.optional_product_ids
            ]
            if not only_main_product
            else [],
        )

    @route('/crm_product_configurator/create_product', type='json', auth='user')
    def purchase_product_configurator_create_product(self, product_template_id, combination):
        """ Create the product when there is a dynamic attribute in the combination.
        """
        product_template = request.env['product.template'].browse(product_template_id)
        combination = request.env['product.template.attribute.value'].browse(combination)
        product = product_template._create_product_variant(combination)
        return product.id

    @route('/crm_product_configurator/update_combination', type='json', auth='user')
    def purchase_product_configurator_update_combination(self, **kwargs):
        """ Return the updated combination information. """
        product_template_id = kwargs.get('product_template_id')
        combination = kwargs.get('combination')
        quantity = kwargs.get('quantity')
        currency_id = kwargs.get('currency_id')
        product_uom_id = kwargs.get('product_uom_id')
        company_id = kwargs.get('company_id')

        if company_id:
            request.update_context(allowed_company_ids=[company_id])

        product_template = request.env['product.template'].browse(product_template_id)
        product_uom = request.env['uom.uom'].browse(product_uom_id)
        currency = request.env['res.currency'].browse(currency_id)
        combination = request.env['product.template.attribute.value'].browse(combination)
        product = product_template._get_variant_for_combination(combination)

        return self._get_basic_product_information(
            product or product_template,
            combination,
            quantity=quantity or 0.0,
            uom=product_uom,
            currency=currency,
        )

    @route('/crm_product_configurator/get_optional_products', type='json', auth='user')
    def purchase_product_configurator_get_optional_products(
        self,
        product_template_id,
        combination,
        parent_combination,
        currency_id=None,
        company_id=None,
    ):
        """ Return information about optional products for the given `product.template`.
        """
        if company_id:
            request.update_context(allowed_company_ids=[company_id])

        product_template = request.env['product.template'].browse(product_template_id)
        parent_combination = request.env['product.template.attribute.value'].browse(
            parent_combination + combination
        )

        return [
            dict(
                **self._get_product_information(
                    optional_product_template,
                    optional_product_template._get_first_possible_combination(
                        parent_combination=parent_combination
                    ),
                    currency_id,
                    parent_combination=parent_combination,
                ),
                parent_product_tmpl_ids=[product_template.id],
            )
            for optional_product_template in product_template.optional_product_ids
        ]

    @http.route('/crm_product_configurator/save_to_crm', type='json', auth='user', methods=['POST'])
    def save_to_crm(self, **kwargs):
        main_product = kwargs.get('main_product')
        optional_products = kwargs.get('optional_products', [])
        crm_lead_id = kwargs.get('crm_lead_id')

        _logger.info(f"[CRM Configurator] Received payload with lead_id={crm_lead_id}")

        if not crm_lead_id or not main_product:
            return {'error': 'Missing required data: crm_lead_id or main_product'}

        lead = request.env['crm.lead'].sudo().browse(int(crm_lead_id))
        if not lead.exists():
            return {'error': 'Lead not found'}

        def create_or_update_material_line(product_data, lead):
            try:
                # === Extract inputs from payload ===
                ptav_ids = list(map(int, product_data.get('ptav_ids', [])))
                template_id = int(product_data.get('product_template_id'))
                quantity = float(product_data.get('quantity', 1.0))
                product_id = product_data.get('product_id')
                custom_attribute_values = product_data.get('custom_attribute_values', [])
                m2o_values = product_data.get('m2o_values', [])
                dimensions = product_data.get('dimensions', [])

                # Filter UNIQUE dimensions
                unique_dims = []
                seen_dims = set()
                for d in dimensions:
                    # 🔥 Include qty in uniqueness check to allow same dims with different qtys
                    key = (float(d.get('length', 0)), float(d.get('width', 0)), float(d.get('qty', 1)))
                    if key not in seen_dims:
                        unique_dims.append(d)
                        seen_dims.add(key)
                dimensions = unique_dims

                # Format "Size" (Dimensions) summary for description
                dimensions_summary = ""
                if dimensions:
                    dim_parts = []
                    for i, dim in enumerate(unique_dims):
                        l_val = dim.get('length', 0)
                        w_val = dim.get('width', 0)
                        q_val = dim.get('qty', 1)
                        # Padding for alignment: "Size: " is 6 chars
                        if i == 0:
                            dim_parts.append(f"Size: {l_val} X {w_val} = {int(float(q_val)):02d} Nos")
                        else:
                            dim_parts.append(f"      {l_val} X {w_val} = {int(float(q_val)):02d} Nos")
                    dimensions_summary = "\n".join(dim_parts)

                # 🔥 CHECK FOR QUANTITY ATTRIBUTE
                # Iterate through custom values to find if any attribute is marked as 'is_quantity'
                for custom_val in custom_attribute_values:
                    ptav_id = custom_val.get('ptav_id')
                    custom_value = custom_val.get('custom_value')
                    
                    if ptav_id and custom_value:
                        ptav = request.env['product.template.attribute.value'].browse(int(ptav_id))
                        if ptav.attribute_id.is_quantity:
                            try:
                                quantity = float(custom_value)
                                _logger.info(f"✅ Quantity set from attribute '{ptav.attribute_id.name}': {quantity}")
                            except ValueError:
                                _logger.warning(f"⚠️ Invalid quantity value '{custom_value}' for attribute '{ptav.attribute_id.name}'")

                # 🔥 CHECK FOR QUANTITY UOM ATTRIBUTE
                # Find the "Quantity UOM" attribute value and map it to uom.uom
                quantity_uom_value = None
                for ptav_id in ptav_ids:
                    ptav = request.env['product.template.attribute.value'].browse(int(ptav_id))
                    if ptav.attribute_id.name == "Quantity UOM":
                        quantity_uom_value = ptav.name
                        _logger.info(f"✅ Found Quantity UOM attribute value: {quantity_uom_value}")
                        break
                
                # Search for matching UOM in uom.uom
                uom_to_set = None
                if quantity_uom_value:
                    matching_uom = request.env['uom.uom'].sudo().search([
                        ('name', '=', quantity_uom_value)
                    ], limit=1)
                    
                    if matching_uom:
                        uom_to_set = matching_uom.id
                        _logger.info(f"✅ Matched UOM '{quantity_uom_value}' to uom.uom ID: {uom_to_set}")
                    else:
                        _logger.warning(f"⚠️ No matching uom.uom found for '{quantity_uom_value}', UOM will be left blank")
                        uom_to_set = False

                # 🔥 MULTIPLE FILE UPLOAD PAYLOAD
                file_upload_list = product_data.get('file_upload', [])
                if isinstance(file_upload_list, dict):
                    file_upload_list = [file_upload_list] if file_upload_list else []
                
                # NEW: MULTIPLE BOQ ATTACHMENT PAYLOAD
                boq_upload_list = product_data.get('conditional_file_upload', [])
                if isinstance(boq_upload_list, dict):
                    boq_upload_list = [boq_upload_list] if boq_upload_list else []

                if not product_id:
                    _logger.warning(
                        f"[CRM Configurator] Skipping: No product_id for template_id={template_id}"
                    )
                    return

                # Clean up blank lines
                request.env['crm.material.line'].sudo().search([
                    ('lead_id', '=', lead.id),
                    ('product_id', '=', False),
                ]).unlink()

                # Get product variant
                product_variant = request.env['product.product'].sudo().browse(int(product_id))
                if not product_variant.exists():
                    raise ValueError(f"Product ID {product_id} not found")

                if not product_variant.product_tmpl_id:
                    _logger.error(f"Product {product_id} has no template!")
                    return {'error': f'Product {product_id} is invalid (no template)'}

                template = product_variant.product_tmpl_id

                if template.id != template_id:
                    _logger.warning(
                        f"Template ID mismatch: expected {template_id}, got {template.id}"
                    )

                # UoM - Prioritize Quantity UOM attribute if found
                if uom_to_set is not None:
                    # Use the UOM from "Quantity UOM" attribute
                    uom_id = uom_to_set
                    if uom_id:
                        _logger.info(f"✅ Using UOM from Quantity UOM attribute: {uom_id}")
                    else:
                        _logger.info(f"⚠️ No matching UOM found for Quantity UOM attribute, leaving blank")
                else:
                    # Fall back to product's default UOM
                    uom_id = product_variant.uom_id.id if product_variant.uom_id else False
                    if not uom_id:
                        _logger.warning(f"Product {product_id} has no UOM, using default")
                        uom_rec = request.env.ref('uom.product_uom_unit', raise_if_not_found=False)
                        if uom_rec:
                            uom_id = uom_rec.id

                category_id = template.categ_id.id if template.categ_id else False

                # PTAV values of this variant
                attribute_values = product_variant.product_template_attribute_value_ids


                # ✅ NEW: Contextual M2O storage (Per-record mapping: { ptal_id_str: res_id })
                contextual_m2o_data = {}
                for m2o_val in m2o_values:
                    ptal_id = m2o_val.get('ptal_id')
                    res_id = m2o_val.get('res_id')
                    if ptal_id:
                        contextual_m2o_data[str(ptal_id)] = res_id
                        _logger.info(f"[CRM Configurator] Contextual M2O mapped: {ptal_id} -> {res_id}")
                
                # 🔥 FIX for "Length"/"Width" unit stripping (Generic)
                # We must ensure that Length/Width are sent as pure numbers in attributes_json
                # This loop handles Non-M2O attributes (Select/Radio) which were missed by m2o_attr_summary logic
                cleaned_attributes = {}
                if ptav_ids:
                    # Get all selected PTAVs
                    selected_ptavs = request.env['product.template.attribute.value'].browse(ptav_ids)
                    for ptav in selected_ptavs:
                        attr_name = ptav.attribute_id.name
                        if not attr_name: continue
                        
                        attr_name_lower = attr_name.strip().lower()
                        
                        # 🔥 NEW: Skip Custom Attributes in Generic Cleaner
                        # Custom attributes (like Length/Width input) are handled in the "Custom Logic" block below.
                        # Processing them here might extract the placeholder name instead of the user's value.
                        if ptav.is_custom:
                            continue

                        if attr_name_lower in ['length', 'width']:
                             val = ptav.name
                             # Strip units
                             try:
                                import re
                                numeric_match = re.search(r'[-+]?\d*\.?\d+', str(val))
                                if numeric_match:
                                    clean_val = numeric_match.group()
                                    cleaned_attributes[attr_name] = clean_val # Use original case key
                                    _logger.info(f"🔧 [Generic] Stripped unit from {attr_name}: '{val}' -> '{clean_val}'")
                                else:
                                    cleaned_attributes[attr_name] = val
                             except Exception as e:
                                _logger.warning(f"⚠️ Failed to strip unit from {attr_name}: {e}")

                # Prepare value summary for attributes_json recompute (Used in crm_customisation/write)
                # Note: crm_customisation/write expects { field_name: value }
                # For M2O, we'll put the record's display name if we have it, so spreadsheet shows text.
                # However, the REAL storage for logic is contextual_m2o_selections.
                m2o_attr_summary = {}
                for ptal_id_str, res_id in contextual_m2o_data.items():
                    if not res_id: continue
                    line_ptal = request.env['product.template.attribute.line'].sudo().browse(int(ptal_id_str))
                    if line_ptal.exists():
                        rec = request.env[line_ptal.attribute_id.m2o_model_id.model].sudo().browse(res_id)
                        m2o_attr_summary[line_ptal.attribute_id.name] = rec.display_name if rec.exists() else ""
                        
                        # 🔥 FIX: Strip units from Length/Width for spreadsheet compatibility
                        # Use loose matching for attribute name
                        attr_name_lower = line_ptal.attribute_id.name.strip().lower()
                        if attr_name_lower in ['length', 'width'] and m2o_attr_summary[line_ptal.attribute_id.name]:
                            try:
                                import re
                                val = m2o_attr_summary[line_ptal.attribute_id.name]
                                # Extract only numeric part (e.g., "100.0 mm" -> "100.0")
                                numeric_match = re.search(r'[-+]?\d*\.?\d+', str(val))
                                if numeric_match:
                                    m2o_attr_summary[line_ptal.attribute_id.name] = numeric_match.group()
                                    _logger.info(f"🔧 Stripped unit from {line_ptal.attribute_id.name}: '{val}' -> '{m2o_attr_summary[line_ptal.attribute_id.name]}'")
                            except Exception as e:
                                _logger.warning(f"⚠️ Failed to strip unit from {line_ptal.attribute_id.name}: {e}")

                # STOP: Global PTAV writing is removed to prevent leak!

                # Re-read to get updated m2o_res_id values
                attribute_values = product_variant.product_template_attribute_value_ids

                # Check if template has file_upload attribute
                has_file_upload_ptav = any(
                    av.attribute_id.display_type == 'file_upload' for av in attribute_values
                )

                # Build description with proper grouping and filtering
                all_raw_attributes = {} # { attr_name_lower: value_str }
                attr_name_map = {}      # { attr_name_lower: original_name }

                # 🔥 Check if "Gel Coat REQ" is set to "No"
                gel_coat_required = True
                for coating_ptal in template.attribute_line_ids:
                    if coating_ptal.attribute_id.name and "gel coat req" in coating_ptal.attribute_id.name.lower():
                        selected_ptavs = attribute_values.filtered(lambda v: v.attribute_line_id == coating_ptal)
                        for ptav in selected_ptavs:
                            if ptav.name and ptav.name.lower() == "no":
                                gel_coat_required = False
                                break
                        break

                for loop_ptal in template.attribute_line_ids:
                    attr_name = loop_ptal.attribute_id.name or ""
                    attr_name_lower = attr_name.lower()
                    
                    if loop_ptal.attribute_id.display_type == "file_upload":
                        continue
                    
                    # Fetch selected value
                    selected_ptavs = attribute_values.filtered(lambda v: v.attribute_line_id == loop_ptal)
                    if not selected_ptavs:
                        continue

                    display_values = []
                    for ptav in selected_ptavs:
                        val = ""
                        if ptav.is_custom:
                            for cv in custom_attribute_values:
                                if int(cv.get('ptav_id', 0)) == ptav.id:
                                    val = cv.get('custom_value')
                                    break
                        elif loop_ptal.attribute_id.display_type == "m2o":
                            m2o_res_id = next((m.get('res_id') for m in m2o_values if m.get('ptal_id') == loop_ptal.id), False)
                            if m2o_res_id:
                                rec = request.env[loop_ptal.attribute_id.m2o_model_id.model].sudo().browse(m2o_res_id)
                                val = rec.display_name if rec.exists() else ""
                        else:
                            val = ptav.name
                            
                        if val and str(val).lower() not in ["--select--", "select", "0", "false", "none"]:
                            display_values.append(str(val))
                    
                    if not display_values:
                        continue
                    
                    value_str = ", ".join(display_values)
                    all_raw_attributes[attr_name_lower] = value_str
                    attr_name_map[attr_name_lower] = attr_name

                # 🔥 1. Merge UOMs and extract Quantity
                merged_attributes = {}
                uom_data = {k: v for k, v in all_raw_attributes.items() if k.endswith(" uom")}
                base_data = {k: v for k, v in all_raw_attributes.items() if not k.endswith(" uom")}
                
                # Extract Quantity attribute and UOM
                qty_val_override = all_raw_attributes.get('quantity')
                qty_uom = all_raw_attributes.get('quantity uom') or all_raw_attributes.get('unit') or all_raw_attributes.get('units') or "Nos"
                
                used_uom_keys = set()
                # Sort base_data keys by length descending to match longest possible prefix first
                sorted_base_keys = sorted(base_data.keys(), key=len, reverse=True)
                
                for bk in sorted_base_keys:
                    bv = base_data[bk]
                    # Skip certain keys for main mapping
                    if bk in ["length", "width", "quantity", "quantity uom", "unit", "units"]:
                        continue
                    
                    # Look for matching UOM
                    found_uom_key = False
                    for uk, uv in uom_data.items():
                        if uk in used_uom_keys: continue
                        
                        base_uk = uk.replace(" uom", "").strip()
                        # Fuzzy match: equality or containment (handles "thiknes" vs "thickness")
                        if bk == base_uk or bk in base_uk or base_uk in bk:
                            merged_attributes[bk] = f"{bv} {uv}"
                            used_uom_keys.add(uk)
                            found_uom_key = True
                            break
                    
                    if not found_uom_key:
                        merged_attributes[bk] = bv

                # 🔥 2. Dimensions (Size) Section
                dimensions_summary = ""
                if dimensions:
                    # Filter unique dimensions
                    unique_dims = []
                    seen = set()
                    for d in dimensions:
                        k = (float(d.get('length', 0)), float(d.get('width', 0)))
                        if k not in seen:
                            unique_dims.append(d)
                            seen.add(k)
                    
                    dim_lines = []
                    for i, dim in enumerate(unique_dims):
                        l_val = dim.get('length', 0)
                        w_val = dim.get('width', 0)
                        row_qty = f"{int(float(dim.get('qty', 1))):02d}"
                        
                        if i == 0:
                            dim_lines.append(f"Size: {l_val} X {w_val} = {row_qty} {qty_uom}")
                        else:
                            dim_lines.append(f"      {l_val} X {w_val} = {row_qty} {qty_uom}")
                    dimensions_summary = "\n".join(dim_lines)

                # 🔥 3. Grouping and Final Description logic
                layout_map = {
                    'profile': 'header1',
                    'thickness': 'header1', 'thiknes': 'header1',
                    'colour': 'header2', 'color': 'header2',
                    'resin': 'header2', 'raisin type': 'header2', 
                    'raisin color': 'header2', 'gel-coat color': 'header2', 'color/pigment': 'header2',
                    'boq': 'footer',
                    'gel coat req': 'footer', 'gelcoat req': 'footer',
                    'gel coat': 'footer', 'gelcoat': 'footer', 'gel-coat': 'footer',
                }
                
                # Build valid attributes based on merged data and gel coat logic
                final_valid_attrs = {}
                for k, v in merged_attributes.items():
                    is_gelcoat_attr = "gel" in k and "coat" in k and "req" not in k
                    if not gel_coat_required and is_gelcoat_attr:
                        continue
                    final_valid_attrs[k] = v

                ordered_results = {'header1': [], 'header2': [], 'footer': [], 'others': []}
                for k, v in final_valid_attrs.items():
                    category = layout_map.get(k, 'others')
                    label = attr_name_map.get(k, k.capitalize())
                    ordered_results[category].append(f"{label} : {v}")

                # Build final lines with strict sequence
                final_desc_lines = []
                # Header 1: Profile & Thickness
                if ordered_results['header1']:
                    final_desc_lines.append("          ".join(ordered_results['header1']))

                # Header 2: Colour & Resin variations
                if ordered_results['header2']:
                    # Sub-pairing logic for header2 if multiple items exist
                    h2_items = ordered_results['header2']
                    for j in range(0, len(h2_items), 2):
                        pair = h2_items[j:j+2]
                        final_desc_lines.append("          ".join(pair))
                
                # Size Line (Always follows headers)
                if dimensions_summary:
                    final_desc_lines.append(dimensions_summary)
                
                # Footer & Others
                for line in ordered_results['footer']:
                    final_desc_lines.append(line)
                for line in ordered_results['others']:
                    final_desc_lines.append(line)

                attribute_description = "\n".join(final_desc_lines)
                _logger.info(f"📋 Final attribute_description:\n{attribute_description}")

                # =========================
                # BUILD DISPLAY NAME
                # =========================
                if product_variant.default_code:
                    base_name = f"[{product_variant.default_code}] {product_variant.name}"
                else:
                    base_name = product_variant.name

                # Attributes summary for display name (SKIP file_upload, is_quantity, gel-coat if not required)
                attributes_summary_parts = []
                for attr_value in attribute_values:
                    if attr_value.attribute_id.display_type == "file_upload":
                        continue
                    if attr_value.attribute_id.is_quantity:
                        continue
                    
                    # 🔥 Skip gel-coat attributes if Gel Coat REQ is "No"
                    attr_name_lower = attr_value.attribute_id.name.lower() if attr_value.attribute_id.name else ""
                    
                    # 🔥 FIX: Remove Quantity and UOM attributes from display summary
                    if attr_name_lower in ["quantity", "quantity uom", "units", "unit"]:
                        continue

                    is_gel_coat_req_attr = "gel coat req" in attr_name_lower or "gelcoat req" in attr_name_lower
                    is_gelcoat_attr = (
                        attr_value.attribute_id.is_gelcoat_required_flag or 
                        ("gel" in attr_name_lower and "coat" in attr_name_lower and "req" not in attr_name_lower)
                    )
                    if not gel_coat_required and is_gelcoat_attr and not is_gel_coat_req_attr:
                        continue
                    
                    if not attr_value.is_custom:
                        if attr_value.attribute_id.display_type == "m2o":
                            if attr_value.m2o_res_id:
                                rec = request.env[
                                    attr_value.attribute_id.m2o_model_id.model
                                ].sudo().browse(attr_value.m2o_res_id)
                                attributes_summary_parts.append(rec.display_name)
                            else:
                                attributes_summary_parts.append(attr_value.name)
                        else:
                            attributes_summary_parts.append(attr_value.name)

                for custom_val in custom_attribute_values:
                    if custom_val.get('custom_value'):
                        attributes_summary_parts.append(custom_val['custom_value'])

                attributes_summary = ", ".join(attributes_summary_parts)
                product_display_name = (
                    f"{base_name} ({attributes_summary})"
                    if attributes_summary
                    else base_name
                )

                # =========================
                # BUILD ATTRIBUTE SUMMARY
                # =========================
                attribute_summary_parts = []
                for cat in ['header1', 'header2', 'footer', 'others']:
                    attribute_summary_parts.extend(ordered_results[cat])
                attribute_summary = ", ".join(attribute_summary_parts)

                # =========================
                # FULL DESCRIPTION
                # =========================
                full_description = attribute_description
                
                # Prepend sales description if exists
                base_description = (product_variant.description_sale or template.description_sale or "")
                if base_description:
                    full_description = f"{base_description}\n\n{full_description}"
                
                # Note: dimensions_summary is now integrated into attribute_description for better ordering
                # but we keep this check for safety if attribute_description was somehow empty
                if not full_description and dimensions_summary:
                    full_description = dimensions_summary

                # =========================
                # CREATE OR UPDATE LINE
                # =========================
                existing_line = False
                ml_id = product_data.get('material_line_id')
                if ml_id:
                    existing_line = request.env['crm.material.line'].sudo().browse(int(ml_id))
                    if not existing_line.exists():
                        existing_line = False

                # Set quantity priority:
                # 1. "Quantity" attribute value
                # 2. product_data['quantity']
                final_record_qty = 1.0
                if qty_val_override:
                    try:
                        final_record_qty = float(qty_val_override)
                    except:
                        final_record_qty = float(product_data.get('quantity', 1.0))
                else:
                    final_record_qty = float(product_data.get('quantity', 1.0))

                # Prepare value summary for attributes_json recompute
                line_vals = {
                    'product_id': product_variant.id,
                    'quantity': final_record_qty,
                    'product_template_id': template.id,
                    'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
                }

                # Set basic dimensions for compatibility (from 1st row)
                if dimensions:
                    first_dim = dimensions[0]
                    line_vals.update({
                        'length': float(first_dim.get('length', 0)),
                        'width': float(first_dim.get('width', 0)),
                    })
                    # Only update quantity from dimension if override NOT present
                    if not qty_val_override:
                        line_vals['quantity'] = float(first_dim.get('qty', 1.0))

                # =========================
                # 🔥 MULTI-FILE HANDLING
                # =========================
                def process_attachments(file_list, res_model, res_id=0):
                    attachment_ids = []
                    if not file_list:
                        return attachment_ids
                    for f in file_list:
                        fname = f.get('name') or f.get('file_name')
                        fdata = f.get('data') or f.get('file_data')
                        if fname and fdata:
                            try:
                                if ',' in fdata:
                                    fdata = fdata.split(',')[1]
                                attachment = request.env['ir.attachment'].sudo().create({
                                    'name': fname,
                                    'datas': fdata,
                                    'res_model': res_model,
                                    'res_id': res_id,
                                })
                                attachment_ids.append(attachment.id)
                            except Exception as e:
                                _logger.error(f"❌ Failed to create attachment '{fname}': {e}")
                    return attachment_ids

                # Process attachments BEFORE create to satisfy constraints
                drawing_ids = process_attachments(file_upload_list, 'crm.material.line')
                boq_ids = process_attachments(boq_upload_list, 'crm.material.line')

                if drawing_ids:
                    line_vals['attached_file_ids'] = [(6, 0, drawing_ids)]
                    # Set single field for backward compatibility & constraints during create
                    first_f = file_upload_list[0]
                    fdata = first_f.get('data') or first_f.get('file_data')
                    if fdata:
                        if ',' in fdata: fdata = fdata.split(',')[1]
                        line_vals['attached_file_id'] = fdata
                        line_vals['attached_file_name'] = first_f.get('name') or first_f.get('file_name')
                
                if boq_ids:
                    line_vals['boq_attachment_ids'] = [(6, 0, boq_ids)]
                    # Set single field for backward compatibility & constraints during create
                    first_f = boq_upload_list[0]
                    fdata = first_f.get('data') or first_f.get('file_data')
                    if fdata:
                        if ',' in fdata: fdata = fdata.split(',')[1]
                        line_vals['boq_attachment_id'] = fdata
                        line_vals['boq_attachment_name'] = first_f.get('name') or first_f.get('file_name')

                # Optional fields
                if uom_id:
                    line_vals['product_uom_id'] = uom_id
                if category_id:
                    line_vals['product_category_id'] = category_id
                if product_display_name:
                    line_vals['product_display_name'] = product_display_name
                if attribute_summary:
                    line_vals['attribute_summary'] = attribute_summary
                if full_description:
                    line_vals['description'] = full_description

                # Inject M2O selections into their dedicated field
                line_vals['contextual_m2o_selections'] = contextual_m2o_data
                # Inject text summaries for spreadsheet (hits attributes_json in write)
                line_vals.update(m2o_attr_summary)
                
                # 🔥 Inject cleaned generic attributes (Length/Width stripped)
                # This overrides any previous un-stripped value from m2o_attr_summary if duplicates exist
                if cleaned_attributes:
                    line_vals.update(cleaned_attributes)
                    _logger.info(f"✅ Injected cleaned attributes into line_vals: {cleaned_attributes}")

                # Custom attribute values
                if custom_attribute_values:
                    custom_vals_commands = []
                    for custom_val in custom_attribute_values:
                        ptav_id = custom_val.get('ptav_id')
                        custom_value = custom_val.get('custom_value', '')
                        if ptav_id and custom_value:
                            # 🔥 NEW: Strip units if this is Length/Width
                            attr_name = request.env['product.template.attribute.value'].browse(int(ptav_id)).attribute_id.name
                            if attr_name and attr_name.strip().lower() in ['length', 'width']:
                                try:
                                    import re
                                    numeric_match = re.search(r'[-+]?\d*\.?\d+', str(custom_value))
                                    if numeric_match:
                                        stripped_val = numeric_match.group()
                                        _logger.info(f"🔧 [Custom] Stripped unit from {attr_name}: '{custom_value}' -> '{stripped_val}'")
                                        custom_value = stripped_val
                                        # Also update line_vals to ensure attributes_json gets the clean value
                                        line_vals[attr_name] = stripped_val
                                except Exception as e:
                                    _logger.warning(f"⚠️ Failed to strip custom unit from {attr_name}: {e}")

                            custom_vals_commands.append((
                                0, 0, {
                                    'custom_product_template_attribute_value_id': int(ptav_id),
                                    'custom_value': custom_value,
                                }
                            ))

                    if custom_vals_commands:
                        line_vals['product_custom_attribute_value_ids'] = custom_vals_commands

                # =========================
                # CREATE OR UPDATE LINE
                # =========================
                if existing_line:
                    _logger.info(
                        f"[CRM Configurator] Updating line {existing_line.id}: "
                        f"{product_display_name}"
                    )
                    existing_line.write(line_vals)
                    target_line = existing_line
                else:
                    _logger.info(
                        f"[CRM Configurator] Creating new line: {product_display_name}"
                    )
                    # Try to update last blank line first
                    last_line = request.env['crm.material.line'].sudo().search([
                        ('lead_id', '=', lead.id),
                        ('product_id', '=', False),
                    ], order='id desc', limit=1)
                    
                    if last_line:
                        last_line.write(line_vals)
                        target_line = last_line
                    else:
                        line_vals['lead_id'] = lead.id
                        target_line = request.env['crm.material.line'].sudo().create(line_vals)
                
                # Update attachments with the correct res_id
                all_attachment_ids = drawing_ids + boq_ids
                if all_attachment_ids and target_line:
                    request.env['ir.attachment'].sudo().browse(all_attachment_ids).write({
                        'res_id': target_line.id
                    })
                    
                    _logger.info(
                        f"[CRM Configurator] Linked {len(drawing_ids)} Drawings and {len(boq_ids)} BOQs "
                        f"to line {target_line.id}"
                    )

                # =============================================================
                # 🔥 PARENT-CHILD ARCHITECTURE (Length Grouping)
                # =============================================================
                
                # 1. DELETE existing child dimension rows for this line
                request.env['crm.material.line'].sudo().search([
                    ('original_line_id', '=', target_line.id),
                    ('is_dimension_row', '=', True)
                ]).unlink()
                
                # 2. CREATE Child Rows for UNIQUE dimensions
                # These are the ones shown in the Spreadsheet
                unique_dims = []
                seen_dims = set()
                for d in dimensions:
                    key = (float(d.get('length', 0)), float(d.get('width', 0)))
                    if key not in seen_dims:
                        unique_dims.append(d)
                        seen_dims.add(key)

                _logger.info(f"[CRM Configurator] Creating {len(unique_dims) - 1} unique child dimension rows for Parent line {target_line.id}")
                child_lines = []
                # 🔥 FIX: Skip the first unique dimension as it is already on the Parent Line
                for dim in unique_dims[1:]:
                    # Need to update attributes_json for the child to show correct Length/Width
                    # Parent has its own Length/Width in attributes_json, we must overwrite it for child
                    child_attrs = target_line.attributes_json.copy() if target_line.attributes_json else {}
                    
                    # Find key for length/width in existing attributes (could be "Length", "length", etc.)
                    # We want to match what is currently there. 
                    # If direct key "Length" exists, use it.
                    l_val = float(dim.get('length', 0))
                    w_val = float(dim.get('width', 0))
                    q_val = float(dim.get('qty', 1.0)) # 🔥 NEW
                    
                    # Update known keys if they exist (case-insensitive check), or default to capitalized
                    l_key_to_set = 'Length'
                    w_key_to_set = 'Width'
                    
                    for k in child_attrs.keys():
                        if k.strip().lower() == 'length':
                            l_key_to_set = k
                        elif k.strip().lower() == 'width':
                            w_key_to_set = k
                            
                    child_attrs[l_key_to_set] = l_val
                    child_attrs[w_key_to_set] = w_val
                    
                    child_line = target_line.copy({
                        'length': l_val,
                        'width': w_val,
                        'quantity': q_val, # 🔥 SET QUANTITY
                        'is_dimension_row': True,
                        'original_line_id': target_line.id,
                        'lead_id': lead.id,
                        'attributes_json': child_attrs # Pass updated attributes
                    })
                    
                    child_lines.append(child_line)
                    _logger.info(f"   - Created child line {child_line.id} with length {child_line.length} and attrs {child_attrs.get('Length')}")

                # 3. Aggregation Note:
                # The Parent line (target_line) remains visible in CRM.
                # Its description already summarizes all dimensions.
                # The Spreadsheet will now be linked to these Child lines.

            except Exception as e:
                _logger.error(
                    f"[CRM Configurator] Error: {repr(e)}\n{traceback.format_exc()}"
                )
                raise


        # Retry logic for concurrent update errors
        max_retries = 3
        retry_delay = 0.2  # Start with 200ms delay
        last_error = None
        
        for attempt in range(max_retries):
            try:
                create_or_update_material_line(main_product, lead)
                for opt in optional_products:
                    create_or_update_material_line(opt, lead)

                request.env.cr.commit()
                return {'success': True}
            except Exception as e:
                last_error = e
                error_msg = str(e).lower()
                
                # Check if it's a concurrent update error and we have retries left
                if "concurrent update" in error_msg and attempt < max_retries - 1:
                    _logger.warning(
                        f"[CRM Configurator] Concurrent update error on attempt {attempt + 1}/{max_retries}, "
                        f"retrying in {retry_delay}s..."
                    )
                    request.env.cr.rollback()
                    import time
                    time.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                    continue
                else:
                    # Last attempt or different error
                    _logger.error(f"[CRM Configurator] Fatal error after {attempt + 1} attempts: {repr(e)}")
                    request.env.cr.rollback()
                    return {'success': False, 'error': str(e)}
        
        # Should not reach here, but just in case
        _logger.error(f"[CRM Configurator] All retries exhausted: {repr(last_error)}")
        return {'success': False, 'error': str(last_error)}

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------
    def _get_product_information(
        self,
        product_template,
        combination,
        currency_id,
        quantity=1,
        product_uom_id=None,
        parent_combination=None,
        material_line_id=None,
    ):
        product_uom = request.env['uom.uom'].browse(product_uom_id)
        currency = request.env['res.currency'].browse(currency_id)
        product = product_template._get_variant_for_combination(combination)

        attribute_exclusions = product_template._get_attribute_exclusions(
            parent_combination=parent_combination,
            combination_ids=combination.ids,
        )

        # ✅ Load M2O selections from material line if present
        contextual_m2o = {}
        if material_line_id:
            line = request.env['crm.material.line'].sudo().browse(int(material_line_id))
            if line.exists() and line.contextual_m2o_selections:
                contextual_m2o = line.contextual_m2o_selections

        return dict(
            product_tmpl_id=product_template.id,
            **self._get_basic_product_information(
                product or product_template,
                combination,
                quantity=quantity,
                uom=product_uom,
                currency=currency,
            ),
            quantity=quantity,
            attribute_lines=[
                dict(
                    id=loop_ptal.id,
                    # ATTRIBUTE meta (with m2o model info and pair_with_previous)
                    attribute=dict(
                        **loop_ptal.attribute_id.read(
                            ['id', 'name', 'display_type', 'm2o_model_id', 'pair_with_previous', 'is_width_check', 'is_quantity', 'is_gelcoat_required_flag']
                        )[0],
                        m2o_values=(
                            [
                                dict(id=rec.id, name=rec.display_name)
                                for rec in request.env[
                                    loop_ptal.attribute_id.m2o_model_id.model
                                ]
                                .sudo()
                                .search([], order="name asc")
                            ]
                            if (
                                loop_ptal.attribute_id.display_type == "m2o"
                                and loop_ptal.attribute_id.m2o_model_id
                                and loop_ptal.attribute_id.m2o_model_id.model
                            )
                            else []
                        ),
                    ),
                    # PTAV list
                    attribute_values=[
                        self._prepare_ptav_data(ptav, loop_ptal, contextual_m2o)
                        for ptav in loop_ptal.product_template_value_ids
                        if ptav.ptav_active
                        or (combination and ptav.id in combination.ids)
                    ],
                    selected_attribute_value_ids=combination.filtered(
                        lambda c, p=loop_ptal: p in c.attribute_line_id
                    ).ids,
                    create_variant=loop_ptal.attribute_id.create_variant,
                )
                for loop_ptal in product_template.attribute_line_ids.sorted('sequence')
            ],
            exclusions=attribute_exclusions['exclusions'],
            archived_combinations=attribute_exclusions['archived_combinations'],
            parent_exclusions=attribute_exclusions['parent_exclusions'],
        )

    def _get_basic_product_information(self, product_or_template, combination, **kwargs):
        """ Return basic information about a product
        """
        basic_information = dict(
            **product_or_template.read(['description_sale', 'display_name'])[0]
        )
        # If the product is a template, adapt name using combination
        if not product_or_template.is_product_variant:
            basic_information['id'] = False
            combination_name = combination._get_combination_name()
            if combination_name:
                basic_information.update(
                    display_name=f"{basic_information['display_name']} ({combination_name})"
                )
        return dict(
            **basic_information,
            price=product_or_template.standard_price,
        )

    def _prepare_ptav_data(self, ptav, loop_ptal, contextual_m2o):
        """Helper to safely prepare PTAV dictionary without keyword conflicts"""
        data = ptav.read(['name', 'html_color', 'image', 'is_custom', 'm2o_res_id', 'required_file'])[0]
        if loop_ptal.attribute_id.display_type == 'm2o':
            # Override with IDs from contextual_m2o_selections if available
            data['m2o_res_id'] = contextual_m2o.get(str(loop_ptal.id))
        return data