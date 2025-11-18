# -*- coding: utf-8 -*-
from odoo import api, fields, models, _
import json
from odoo.exceptions import ValidationError


class CrmLead(models.Model):
    _inherit = "crm.lead"

    report_grids = fields.Boolean(
        string="Print Variant Grids",
        default=True,
        help="If enabled, shows the product variant matrix in the report."
    )

    grid_product_tmpl_id = fields.Many2one(
        'product.template',
        string='Grid Product Template',
        store=False,
        help="Used for product matrix functionality."
    )
    grid_update = fields.Boolean(
        default=False,
        store=False,
        help="Whether a new matrix needs to be applied."
    )
    grid = fields.Char(
        store=False,
        help="Serialized grid data."
    )
    material_line_ids = fields.One2many(
        "crm.material.line",
        "lead_id",
        string="Materials",
        copy=True,
    )
    @api.onchange('grid_product_tmpl_id')
    def _set_grid_up(self):
        if self.grid_product_tmpl_id:
            self.grid_update = False
            self.grid = json.dumps(self._get_matrix(self.grid_product_tmpl_id))

    @api.onchange('grid')
    def _apply_grid(self):
        if self.grid and self.grid_update:
            grid = json.loads(self.grid)
            product_template = self.env['product.template'].browse(grid['product_template_id'])
            product_ids = set()
            dirty_cells = grid['changes']
            Attrib = self.env['product.template.attribute.value']
            new_lines = []

            for cell in dirty_cells:
                combination = Attrib.browse(cell['ptav_ids'])
                no_variant_attribute_values = combination - combination._without_no_variant_attributes()

                # Create or find product variant from combination
                product = product_template._create_product_variant(combination)

                existing_lines = self.material_line_ids.filtered(
                    lambda line: line.product_id == product and line.product_no_variant_attribute_value_ids == no_variant_attribute_values
                )

                old_qty = sum(existing_lines.mapped('quantity'))
                qty = cell['qty']
                diff = qty - old_qty

                if not diff:
                    continue

                product_ids.add(product.id)

                if existing_lines:
                    if qty == 0:
                        self.material_line_ids -= existing_lines
                    else:
                        if len(existing_lines) > 1:
                            raise ValidationError(_("You cannot change the quantity of a product present in multiple material lines."))
                        else:
                            existing_lines[0].quantity = qty
                else:
                    new_lines.append((0, 0, {
                        'product_id': product.id,
                        'product_template_id': product_template.id,
                        'product_no_variant_attribute_value_ids': [(6, 0, no_variant_attribute_values.ids)],
                        'quantity': qty,
                    }))

            if new_lines:
                self.update({'material_line_ids': new_lines})

    def _get_matrix(self, product_template):
        def has_ptavs(line, sorted_attr_ids):
            ptav = line.product_template_attribute_value_ids.ids
            pnav = line.product_no_variant_attribute_value_ids.ids
            pav = pnav + ptav
            pav.sort()
            return pav == sorted_attr_ids

        matrix = product_template._get_template_matrix()

        if self.material_line_ids:
            lines = matrix['matrix']
            material_lines = self.material_line_ids.filtered(lambda line: line.product_template_id == product_template)
            for row in lines:
                for cell in row:
                    if not cell.get('name', False):
                        matched_line = material_lines.filtered(lambda line: has_ptavs(line, cell['ptav_ids']))
                        if matched_line:
                            cell.update({'qty': sum(matched_line.mapped('quantity'))})

        return matrix
    
    @api.model
    def create_material_line_from_configurator(self, product_data, lead_id=None):
        """
        Create material line directly from configurator data
        """
        try:
            ptav_ids = list(map(int, product_data.get('ptav_ids', [])))
            template_id = int(product_data.get('product_template_id'))
            quantity = float(product_data.get('quantity', 1.0))
            product_id = product_data.get('product_id')
            
            if not product_id:
                return {'error': 'Product ID is required'}
            
            # Get product variant
            product_variant = self.env['product.product'].browse(int(product_id))
            if not product_variant.exists():
                return {'error': f'Product ID {product_id} not found'}
            
            # Prepare line values
            line_vals = {
                'product_id': product_variant.id,
                'quantity': quantity if quantity > 0 else 1.0,
                'product_template_id': template_id,
                'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
            }
            
                
            # Create the line immediately
            new_line = self.env['crm.material.line'].create(line_vals)
            
            return {
                'success': True, 
                'line_id': new_line.id,
                'message': 'Line created successfully'
            }
            
        except Exception as e:
            return {'error': str(e)}