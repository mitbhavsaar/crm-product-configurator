
from odoo.http import Controller, request, route
from odoo import http
import logging

import traceback

_logger = logging.getLogger(__name__)


class ProductConfiguratorController(Controller):

    @route('/crm_product_configurator/get_values', type='json', auth='user')
    def get_product_configurator_values(
            self,
            product_template_id,
            quantity,
            currency_id =None,
            product_uom_id=None,
            company_id=None,
            ptav_ids=None,
            only_main_product=False,
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
                    product_template.attribute_line_ids - combination.attribute_line_id).filtered(
                lambda ptal: ptal.attribute_id.display_type != 'multi')
            combination += unconfigured_ptals.mapped(
                lambda ptal: ptal.product_template_value_ids._only_active()[:1]
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
                        product_uom_id=product_uom_id
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
                        parent_combination=product_template.attribute_line_ids. \
                            product_template_value_ids,
                    ),
                    parent_product_tmpl_ids=[product_template.id],
                ) for optional_product_template in product_template.optional_product_ids
            ] if not only_main_product else []
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
            currency_id = None,
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
                    parent_combination=parent_combination
                ),
                parent_product_tmpl_ids=[product_template.id],
            ) for optional_product_template in product_template.optional_product_ids
        ]

    # @http.route('/crm_product_configurator/save_to_crm', type='json', auth='user', methods=['POST'])
    # def save_to_crm(self, **kwargs):
    #     main_product = kwargs.get('main_product')
    #     optional_products = kwargs.get('optional_products', [])
    #     crm_lead_id = kwargs.get('crm_lead_id')
    #
    #
    #
    #     if not crm_lead_id or not main_product:
    #         return {'error': 'Missing required data: crm_lead_id or main_product'}
    #
    #     lead = request.env['crm.lead'].sudo().browse(int(crm_lead_id))
    #     if not lead.exists():
    #         return {'error': 'Lead not found'}
    #
    #     def create_or_update_material_line(product_data, lead):
    #
    #         try:
    #             ptav_ids = list(map(int, product_data.get('ptav_ids', [])))
    #             template_id = int(product_data.get('product_template_id'))
    #             quantity = float(product_data.get('quantity', 1.0))
    #             product_id = product_data.get('product_id')
    #
    #
    #             if not product_id:
    #                 return
    #
    #             product_variant = request.env['product.product'].sudo().browse(int(product_id))
    #             if not product_variant.exists():
    #                 raise ValueError(f"Product ID {product_id} not found")
    #
    #             template =request.env['product.template'].sudo().browse(int(template_id))
    #             uom_id = product_variant.uom_id.id
    #             attribute_values = request.env['product.template.attribute.value'].sudo().browse(ptav_ids)
    #             attributes = ", ".join(attr.name for attr in attribute_values)
    #             product_display_name = f"[{product_variant.default_code or ''}] {product_variant.name} ({attributes})" if attributes else product_variant.name
    #
    #             # Unique check with product_id, template_id, and ptav_ids
    #
    #             line_vals = {
    #                 'product_id': product_variant.id,
    #                 'quantity': quantity,
    #                 'product_template_id': template.id,
    #                 'product_uom_id': uom_id,
    #                 'product_display_name': product_display_name,
    #                 'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
    #             }
    #             line_vals['lead_id'] = lead.id
    #             request.env['crm.material.line'].sudo().create(line_vals)
    #         except Exception as e:
    #             raise
    #
    #     create_or_update_material_line(main_product, lead)
    #     for opt in optional_products:
    #         create_or_update_material_line(opt, lead)
    #
    #     return {'success': True}

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
                ptav_ids = list(map(int, product_data.get('ptav_ids', [])))
                template_id = int(product_data.get('product_template_id'))
                quantity = float(product_data.get('quantity', 1.0))
                product_id = product_data.get('product_id')

                if not product_id:
                    _logger.warning(f"[CRM Configurator] Skipping: No product_id for template_id={template_id}")
                    return

                # Clean up any blank lines (no product selected)
                request.env['crm.material.line'].sudo().search([
                    ('lead_id', '=', lead.id),
                    ('product_id', '=', False)
                ]).unlink()

                # ✅ GET PRODUCT WITH SAFETY CHECKS
                product_variant = request.env['product.product'].sudo().browse(int(product_id))
                if not product_variant.exists():
                    raise ValueError(f"Product ID {product_id} not found")

                # ✅ CRITICAL: Ensure product has template
                if not product_variant.product_tmpl_id:
                    _logger.error(f"Product {product_id} has no template!")
                    return {'error': f'Product {product_id} is invalid (no template)'}

                template = product_variant.product_tmpl_id

                # ✅ Verify template ID matches
                if template.id != template_id:
                    _logger.warning(f"Template ID mismatch: expected {template_id}, got {template.id}")

                # ✅ Get UOM with fallback
                uom_id = product_variant.uom_id.id if product_variant.uom_id else False
                if not uom_id:
                    _logger.warning(f"Product {product_id} has no UOM, using default")
                    uom_id = request.env.ref('uom.product_uom_unit', raise_if_not_found=False)
                    if uom_id:
                        uom_id = uom_id.id

                # ✅ Get category
                category_id = template.categ_id.id if template.categ_id else False

                # ✅ Build attribute description
                attribute_values = product_variant.product_template_attribute_value_ids

                attribute_lines = []
                for attr_value in attribute_values:
                    attribute_lines.append(f"• {attr_value.attribute_id.name}: {attr_value.name}")

                attribute_description = "\n".join(attribute_lines) if attribute_lines else ""

                # Build display name
                if product_variant.default_code:
                    base_name = f"[{product_variant.default_code}] {product_variant.name}"
                else:
                    base_name = product_variant.name

                attributes_summary = ", ".join(attr.name for attr in attribute_values)
                product_display_name = f"{base_name} ({attributes_summary})" if attributes_summary else base_name

                # Build attribute summary
                attribute_summary = ", ".join(
                    f"{attr.attribute_id.name}: {attr.name}" for attr in attribute_values
                )

                # Build description
                base_description = product_variant.description_sale or template.description_sale or ""
                if attribute_description:
                    if base_description:
                        full_description = f"{base_description}\n\n📋 Selected Attributes:\n{attribute_description}"
                    else:
                        full_description = f"📋 Selected Attributes:\n{attribute_description}"
                else:
                    full_description = base_description

                # ✅ Check for existing line
                def _get_existing_line(lead, template, ptav_ids):
                    lines = request.env['crm.material.line'].sudo().search([
                        ('lead_id', '=', lead.id),
                        ('product_template_id', '=', template.id),
                    ], limit=1)
                    for line in lines:
                        if line.product_id:
                            existing_ptav_ids = set(line.product_id.product_template_attribute_value_ids.ids)
                            if set(ptav_ids) == existing_ptav_ids:
                                return line
                    return False

                existing_line = _get_existing_line(lead, template, ptav_ids)

                # ✅ Prepare line values - ONLY safe fields
                line_vals = {
                    'product_id': product_variant.id,
                    'quantity': quantity if quantity > 0 else 1.0,
                    'product_template_id': template.id,  # Always set from product's template
                    'product_template_attribute_value_ids': [(6, 0, ptav_ids)],
                }

                # Add optional fields only if they have values
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

                # ✅ Create or Update
                if existing_line:
                    _logger.info(f"[CRM Configurator] Updating line {existing_line.id}: {product_display_name}")
                    existing_line.write(line_vals)
                else:
                    _logger.info(f"[CRM Configurator] Creating new line: {product_display_name}")

                    # Check if there's an empty line to update
                    last_line = request.env['crm.material.line'].sudo().search([
                        ('lead_id', '=', lead.id),
                        ('product_id', '=', False)
                    ], order='id desc', limit=1)

                    if last_line:
                        # Update empty line
                        last_line.write(line_vals)
                    else:
                        # Create new line
                        line_vals['lead_id'] = lead.id
                        new_line = request.env['crm.material.line'].sudo().create(line_vals)
                        _logger.info(f"[CRM Configurator] Created line ID: {new_line.id}")

            except Exception as e:
                _logger.error(f"[CRM Configurator] Error: {repr(e)}\n{traceback.format_exc()}")
                raise

        try:
            # Save main product
            create_or_update_material_line(main_product, lead)

            # Save optional products
            for opt in optional_products:
                create_or_update_material_line(opt, lead)

            # Ensure changes are committed
            request.env.cr.commit()

            return {'success': True}

        except Exception as e:
            _logger.error(f"[CRM Configurator] Fatal error: {repr(e)}")
            request.env.cr.rollback()
            return {'success': False, 'error': str(e)}
    
        
    def _get_product_information(
            self,
            product_template,
            combination,
            currency_id,
            quantity=1,
            product_uom_id=None,
            parent_combination=None,
    ):
        """ Return complete information about a product.
        """
        product_uom = request.env['uom.uom'].browse(product_uom_id)
        currency = request.env['res.currency'].browse(currency_id)
        product = product_template._get_variant_for_combination(combination)
        attribute_exclusions = product_template._get_attribute_exclusions(
            parent_combination=parent_combination,
            combination_ids=combination.ids,
        )
        return dict(
            product_tmpl_id=product_template.id,
            **self._get_basic_product_information(
                product or product_template,
                combination,
                quantity=quantity,
                uom=product_uom,
                currency=currency
            ),
            quantity=quantity,
            attribute_lines=[dict(
                id=ptal.id,
                attribute=dict(**ptal.attribute_id.read(['id', 'name', 'display_type'])[0]),
                attribute_values=[
                    dict(
                        **ptav.read(['name', 'html_color', 'image', 'is_custom'])[0],
                    ) for ptav in ptal.product_template_value_ids
                    if ptav.ptav_active or combination and ptav.id in combination.ids
                ],
                selected_attribute_value_ids=combination.filtered(
                    lambda c: ptal in c.attribute_line_id
                ).ids,
                create_variant=ptal.attribute_id.create_variant,
            ) for ptal in product_template.attribute_line_ids],
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
        # If the product is a template, check the combination to compute the name to take dynamic
        # and no_variant attributes into account. Also, drop the id which was auto-included by the
        # search but isn't relevant since it is supposed to be the id of a `product.product` record.
        if not product_or_template.is_product_variant:
            basic_information['id'] = False
            combination_name = combination._get_combination_name()
            if combination_name:
                basic_information.update(
                    display_name=f"{basic_information['display_name']} ({combination_name})"
                )
        return dict(
            **basic_information,
            price=product_or_template.standard_price
        )