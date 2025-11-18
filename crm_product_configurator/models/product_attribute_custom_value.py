
from odoo import fields, models


class ProductAttributeCustomValue(models.Model):
    """
    Model for representing custom attribute values for a CRM order line.
    Inherits from 'product.attribute.custom.value' model.
    """
    _inherit= "product.attribute.custom.value"

    crm_order_line_id = fields.Many2one('crm.material.line',
                                             string="CRM Material Line",
                                             required=True, ondelete='cascade',
                                             help="CRM order lines")