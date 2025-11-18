# -*- coding: utf-8 -*-
from odoo import api, fields, models
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
    def update_material_line_from_configurator(self, payload):
        """
        Alternative method to update material line from configurator
        (if you prefer this approach instead of controller)
        """
        main_product = payload.get('main_product')
        optional_products = payload.get('optional_products', [])
        lead_id = int(payload.get('crm_lead_id')) if payload.get('crm_lead_id') else False

        if not main_product or not lead_id:
            return {'error': 'Missing main product or lead ID'}

        def update_or_create_line(product_data, lead_id):
            product_id = int(product_data.get('product_id', 0)) or False
            template_id = int(product_data.get('product_template_id', 0)) or False
            quantity = float(product_data.get('quantity', 1.0))
            price = float(product_data.get('price', 0.0))
            ptav_ids = list(map(int, product_data.get('ptav_ids', [])))
            line_id = product_data.get('line_id', False)
            uom_id = int(product_data.get('product_uom_id', 0)) or False
            category_id = int(product_data.get('product_category_id', 0)) or False

            # STEP 1: Update via line_id if given
            if line_id:
                line = self.env['crm.material.line'].sudo().browse(int(line_id))
                if line.exists():
                    _logger.info(f"✏️ Updating existing CRM Material Line ID: {line_id}")
                    line.write({
                        'product_id': product_id,
                        'product_template_id': template_id,
                        'quantity': quantity,
                        'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
                        'product_uom_id': uom_id,
                        'product_category_id': category_id,
                    })
                    return {'success': True, 'updated': True, 'line_id': line.id}

            # STEP 2: Find line by lead + template + ptav_ids
            domain = [
                ('lead_id', '=', lead_id),
                ('product_template_id', '=', template_id),
            ]
            candidate_lines = self.env['crm.material.line'].sudo().search(domain)
            for line in candidate_lines:
                if set(line.product_template_attribute_value_ids.ids) == set(ptav_ids):
                    _logger.info(f"🔁 Found matching line without line_id: {line.id}, updating...")
                    line.write({
                        'product_id': product_id,
                        'quantity': quantity,
                        'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
                        'product_uom_id': uom_id,
                        'product_category_id': category_id,
                    })
                    return {'success': True, 'updated': True, 'line_id': line.id}

            # STEP 3: Create new line
            _logger.info("➕ Creating new CRM Material Line")
            new_line = self.env['crm.material.line'].sudo().create({
                'lead_id': lead_id,
                'product_id': product_id,
                'product_template_id': template_id,
                'quantity': quantity,
                'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
                'product_uom_id': uom_id,
                'product_category_id': category_id,
            })
            return {'success': True, 'created': True, 'line_id': new_line.id}

        # Process main product
        result = update_or_create_line(main_product, lead_id)
        if not result.get('success'):
            return result

        # Process optional products
        for opt_product in optional_products:
            opt_result = update_or_create_line(opt_product, lead_id)
            if not opt_result.get('success'):
                return opt_result

        return result