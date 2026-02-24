from odoo import models, fields

class ProductAttribute(models.Model):
    _inherit = "product.attribute"

    display_type = fields.Selection(
        selection_add=[
            ('file_upload', 'File Upload'),
            ('m2o', 'Many2one Selector'),
            ('strictly_numeric', 'Strictly Numeric'),
        ],
        ondelete={
            'file_upload': 'set default',
            'm2o': 'set default',
            'strictly_numeric': 'set default',
        }
    )

    # NEW: Define which model will be used for the Many2one dropdown
    m2o_model_id = fields.Many2one(
        "ir.model",
        string="Many2one Model",
        help="Select the model whose records will be selectable as values."
    )
    
    pair_with_previous = fields.Boolean(
        string="Pair with Previous",
        help="Pair this attribute with the previous one on the same line without label."
    )

    is_width_check = fields.Boolean(string="Check Width")
    
    is_quantity = fields.Boolean(
        string="Is Quantity",
        help="If checked, the value of this attribute will be used as the quantity for the CRM Line."
    )
    is_gelcoat_required_flag = fields.Boolean("Gel Coat Required Attribute")

class ProductAttributeValue(models.Model):
    """Inherit product.attribute.value to add required_file field"""
    _inherit = 'product.attribute.value'
    
    # NEW FIELD FOR CONDITIONAL FILE REQUIREMENT
    required_file = fields.Boolean(
        string="Required File?",
        default=False,
        help="When this value is selected, a file upload will be required."
    )

    # NEW FIELDS FOR FILTERING RESIN TYPE AND GELCOAT
    is_opaque = fields.Boolean(
        string="Opaque",
        help="Check this if this value is valid for Opaque sheet types."
    )
    is_translucent = fields.Boolean(
        string="Translucent",
        help="Check this if this value is valid for Translucent sheet types."
    )
