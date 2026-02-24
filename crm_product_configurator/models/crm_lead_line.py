# -*- coding: utf-8 -*-
from odoo import api, fields, models
from odoo.exceptions import ValidationError
import logging

_logger = logging.getLogger(__name__)


class CrmMaterialLine(models.Model):
    _inherit = "crm.material.line"

    product_config_mode = fields.Selection(
        related='product_template_id.product_config_mode',
        depends=['product_template_id'],
        help="Product configuration mode"
    )

    product_custom_attribute_value_ids = fields.One2many(
        comodel_name='product.attribute.custom.value',
        inverse_name='crm_order_line_id',
        string="Custom Values",
        compute='_compute_custom_attribute_values',
        help="Product custom attribute values",
        store=True,
        readonly=False,
        precompute=True,
        copy=True
    )
    
    attributes_description = fields.Text(
        string=" Description",
        compute="_compute_attributes_description",
        store=True
    )

    attributes_json = fields.Json(
        string="Attribute Map",
        compute="_compute_attributes_json",
        store=True
    )

    contextual_m2o_selections = fields.Json(
        string="Contextual M2O State",
        help="Stores per-line M2O selections: { ptal_id: res_id }",
        copy=True
    )
    
    # BOQ Attachment fields are now inherited from crm_customisation.crm.material.line
    
    requires_conditional_file = fields.Boolean(
        string="Requires File Upload",
        compute="_compute_requires_conditional_file",
        store=True,
        help="True if any selected attribute value has 'Required File?' enabled"
    )
    
    @api.depends('product_template_attribute_value_ids')
    def _compute_requires_conditional_file(self):
        """Check if any selected attribute value requires a file upload"""
        for record in self:
            requires_file = False
            for ptav in record.product_template_attribute_value_ids:
                # Only check for radio/select display types
                if ptav.attribute_id.display_type in ['radio', 'select'] and ptav.required_file:
                    requires_file = True
                    break
            record.requires_conditional_file = requires_file
    
    @api.constrains('product_template_attribute_value_ids', 'boq_attachment_id', 'boq_attachment_ids')
    def _check_conditional_file_required(self):
        """Validate that file is attached when required"""
        for record in self:
            if record.requires_conditional_file and not record.boq_attachment_id and not record.boq_attachment_ids:
                # Find which attribute requires the file
                required_attrs = []
                for ptav in record.product_template_attribute_value_ids:
                    if ptav.attribute_id.display_type in ['radio', 'select'] and ptav.required_file:
                        required_attrs.append(f"{ptav.attribute_id.name}: {ptav.name}")
                
                if required_attrs:
                    raise ValidationError(
                        f"File upload is required for the following selection(s):\n" +
                        "\n".join(f"• {attr}" for attr in required_attrs)
                    )
    
            # Build description with proper grouping and filtering
            all_raw_attributes = {} # { attr_name_lower: value_str }
            attr_name_map = {}      # { attr_name_lower: original_name }

            # Track selected values for logic
            selected_attributes = {ptav.attribute_id.name: ptav.name for ptav in record.product_template_attribute_value_ids if ptav.attribute_id}
            
            # Gel Coat Logic
            gel_coat_req_value = (selected_attributes.get("Gel Coat REQ", "") or selected_attributes.get("Gel Coat Required", "")).lower()
            gel_coat_required = gel_coat_req_value in ["yes", "true", "1", "required"]

            for ptav in record.product_template_attribute_value_ids:
                attr = ptav.attribute_id
                if not attr or attr.display_type == "file_upload" or attr.is_quantity:
                    continue
                
                l_key = attr.name.lower()
                
                val = ""
                if attr.display_type == "m2o":
                    m2o_data = record.contextual_m2o_selections or {}
                    res_id = m2o_data.get(str(ptav.attribute_line_id.id))
                    if res_id:
                        rec = self.env[attr.m2o_model_id.model].sudo().browse(res_id)
                        val = rec.display_name if rec.exists() else ""
                else:
                    val = ptav.name
                
                if val and str(val).lower() not in ["--select--", "select", "0", "false", "none"]:
                    all_raw_attributes[l_key] = str(val)
                    attr_name_map[l_key] = attr.name

            # Add Custom Values
            for custom in record.product_custom_attribute_value_ids:
                ptav = custom.custom_product_template_attribute_value_id
                if ptav and ptav.attribute_id and custom.custom_value:
                    l_key = ptav.attribute_id.name.lower()
                    all_raw_attributes[l_key] = custom.custom_value
                    attr_name_map[l_key] = ptav.attribute_id.name

            # 🔥 1. Merge UOMs and extract Quantity
            merged_attributes = {}
            uom_data = {k: v for k, v in all_raw_attributes.items() if k.endswith(" uom")}
            base_data = {k: v for k, v in all_raw_attributes.items() if not k.endswith(" uom")}
            
            # Extract Quantity and UOM
            qty_val_override = all_raw_attributes.get('quantity')
            qty_uom = all_raw_attributes.get('quantity uom') or all_raw_attributes.get('unit') or all_raw_attributes.get('units') or "Nos"
            
            used_uom_keys = set()
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
                    # Fuzzy match for variations like "thiknes" vs "thickness"
                    if bk == base_uk or bk in base_uk or base_uk in bk:
                        merged_attributes[bk] = f"{bv} {uv}"
                        used_uom_keys.add(uk)
                        found_uom_key = True
                        break
                
                if not found_uom_key:
                    merged_attributes[bk] = bv

            # 🔥 2. Dimensions (Size) Section
            dimensions_lines = []
            if record.length or record.width:
                # Find all related dimensions
                all_dims = [record]
                if not record.is_dimension_row:
                    children = self.env['crm.material.line'].search([('original_line_id', '=', record.id)])
                    all_dims += [c for c in children]
                
                seen_dims = set()
                u_dims = []
                for d in all_dims:
                    k = (float(d.length), float(d.width))
                    if k not in seen_dims:
                        u_dims.append(d)
                        seen_dims.add(k)
                
                for i, d in enumerate(u_dims):
                    q_str = f"{int(float(d.quantity)):02d}"
                    if i == 0:
                        dimensions_lines.append(f"Size: {d.length} X {d.width} = {q_str} {qty_uom}")
                    else:
                        dimensions_lines.append(f"      {d.length} X {d.width} = {q_str} {qty_uom}")

            # 🔥 3. Layout Logic
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
            
            # Filter based on gel coat logic
            final_valid_attrs = {}
            for k, v in merged_attributes.items():
                is_gelcoat_attr = "gel" in k and "coat" in k and "req" not in k
                if not gel_coat_required and is_gelcoat_attr:
                    continue
                final_valid_attrs[k] = v

            ordered_results = {'header1': [], 'header2': [], 'footer': [], 'others': []}
            for l_key, val in final_valid_attrs.items():
                cat = layout_map.get(l_key, 'others')
                label = attr_name_map.get(l_key, l_key.capitalize())
                ordered_results[cat].append(f"{label} : {val}")

            final_desc_lines = []
            # Header 1: Profile & Thickness
            if ordered_results['header1']:
                final_desc_lines.append("          ".join(ordered_results['header1']))
            # Header 2: Colour & Resin variations
            if ordered_results['header2']:
                h2_items = ordered_results['header2']
                for j in range(0, len(h2_items), 2):
                    pair = h2_items[j:j+2]
                    final_desc_lines.append("          ".join(pair))
            
            # Size Section (Always follows headers)
            for dim_l in dimensions_lines: final_desc_lines.append(dim_l)
            for line_str in ordered_results['footer']: final_desc_lines.append(line_str)
            for line_str in ordered_results['others']: final_desc_lines.append(line_str)

            record.attributes_description = "\n".join(final_desc_lines)


            
    @api.depends(
        'attached_file_id',
        'attached_file_name',
        'product_template_attribute_value_ids',
        'product_custom_attribute_value_ids',
        'length',
        'width'
    )
    def _compute_attributes_json(self):
        """Attributes JSON WITHOUT file upload and conditional Gel-coat"""
        for record in self:
            data = {}
            
            try:
                # Collect selected attributes for dependency checks
                selected_attributes = {}
                for ptav in record.product_template_attribute_value_ids:
                    if ptav.attribute_id:
                        selected_attributes[ptav.attribute_id.name] = ptav.name

                # Dependency: Gel Coat REQ/Required == yes → then show Gel-coat
                # Check both "Gel Coat REQ" and "Gel Coat Required" for compatibility
                gel_coat_req_value = (
                    selected_attributes.get("Gel Coat REQ", "") or 
                    selected_attributes.get("Gel Coat Required", "")
                ).lower()
                # Skip Gel-coat if value is "no" or empty
                skip_gel_coat = gel_coat_req_value not in ["yes", "true", "1", "required"]

                # Template attributes (SKIP file_upload)
                for ptav in record.product_template_attribute_value_ids:
                    attr = ptav.attribute_id
                    if not attr or getattr(ptav, 'is_custom', False):
                        continue

                    key = attr.name
                    display_type = attr.display_type

                    # 🔥 SKIP file_upload from JSON
                    if display_type == "file_upload":
                        continue

                    # 🚫 SKIP Gel-coat only when Gel Coat Required != true/yes/1
                    if skip_gel_coat and key.lower() in ["gel-coat", "gel coat"]:
                        continue

                    # 🔥 M2O attributes → use per-line contextual storage
                    if display_type == "m2o":
                        m2o_data = record.contextual_m2o_selections or {}
                        res_id = m2o_data.get(str(ptav.attribute_line_id.id))
                        if res_id:
                            model_name = attr.m2o_model_id.model
                            rec = self.env[model_name].sudo().browse(res_id)
                            if rec.exists():
                                data[key] = rec.display_name
                        continue

                    # Normal
                    if ptav.name and "--select--" not in ptav.name.lower() and "select" not in ptav.name.lower():
                        data[key] = ptav.name

                # Custom Attributes
                for custom in record.product_custom_attribute_value_ids:
                    ptav = custom.custom_product_template_attribute_value_id
                    if ptav and ptav.attribute_id:
                        data[ptav.attribute_id.name] = custom.custom_value

                # 🔥 COMPARE & OVERRIDE with model length/width
                # This ensures the Spreadsheet sees the specific length of each row
                seen_overrides = set()
                import re
                
                for key in list(data.keys()):
                    l_key = key.lower()
                    val = str(data[key])
                    
                    if l_key == "length":
                        if record.length:
                            # 🔥 FIX: Store pure number, do NOT append UOM
                            data[key] = record.length
                        seen_overrides.add("length")
                    elif l_key == "width":
                        if record.width:
                            # 🔥 FIX: Store pure number, do NOT append UOM
                            data[key] = record.width
                        seen_overrides.add("width")
                
                # If they weren't in PTAVs, ADD them specifically
                if "length" not in seen_overrides and record.length:
                    data["Length"] = record.length
                if "width" not in seen_overrides and record.width:
                    data["Width"] = record.width

            except Exception as e:
                _logger.exception(f"❌ Error computing attributes_json: {e}")

            record.attributes_json = data
            _logger.debug(f"✅ attributes_json for Line {record.id}: {data}")

    @api.depends('product_id')
    def _compute_custom_attribute_values(self):
        """
        Checks if the product has custom attribute values associated with it,
        and if those values belong to the valid values of the product template.
        """
        for line in self:
            if not line.product_id:
                line.product_custom_attribute_value_ids = False
                continue
            if not line.product_custom_attribute_value_ids:
                continue
            valid_values = line.product_id.product_tmpl_id. \
                valid_product_template_attribute_line_ids. \
                product_template_value_ids
            # Remove the is_custom values that don't belong to this template
            for attribute in line.product_custom_attribute_value_ids:
                if attribute.custom_product_template_attribute_value_id not in valid_values:
                    line.product_custom_attribute_value_ids -= attribute
    
    @api.model
    def get_list_data(self, list_id, field_names):
        """
        Override to provide data including dynamic attributes from attributes_json
        """
        _logger.info(f"🟢 get_list_data called: list_id={list_id}, fields={field_names}")
        
        try:
            line_id = int(list_id)
        except (ValueError, TypeError):
            _logger.error("Invalid list_id: %s", list_id)
            return []

        line = self.browse(line_id)
        if not line.exists():
            _logger.warning("Line %s not found", line_id)
            return []

        row = {"id": line.id}

        for field in field_names:
            if field in self._fields:
                # Standard field
                val = line[field]
                if hasattr(val, "display_name"):
                    row[field] = val.display_name
                else:
                    row[field] = val
                _logger.info(f"✅ Standard field '{field}' = '{row[field]}'")
            else:
                # Dynamic attribute from attributes_json
                attrs = line.attributes_json or {}
                row[field] = attrs.get(field, "")
                _logger.info(f"🔵 Dynamic field '{field}' = '{row[field]}' from attributes_json")

        _logger.info(f"🟢 Final row data: {row}")
        return [row]